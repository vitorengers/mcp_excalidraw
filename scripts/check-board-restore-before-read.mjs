#!/usr/bin/env node
/**
 * Checks that a board does not answer for its contents before it has read them back.
 *
 * The saved board is put into its store by `seedBoardsFromFiles`, which `src/server.ts` starts
 * from inside the `listen` callback and deliberately does not await: a slow read must not sit
 * between the port opening and the board being usable. What was never closed is the other end
 * of that decision. Between `listen` and the seed finishing, the server is up, `/health` says
 * `healthy`, and every read of a board's contents answers **empty** — not "not ready yet", not
 * an error, but a board with nothing on it.
 *
 * That window is roughly twenty milliseconds on this machine, and it is not theoretical: it is
 * exactly long enough for the caller that has been waiting for `/health` to ask its first
 * question. `scripts/check-notes-column-without-project-browser.mjs` restarts a canvas and
 * reads the board it saved, and it failed on this one run in four (#441) — reporting that a
 * draft written into My Notes had not survived a restart, when it had, and the server simply
 * had not finished reading it. Anything that starts a canvas and reads it immediately is in the
 * same position: the CLI and the MCP tools auto-start one and wait for `/health`, and an export
 * or a `describe` taken in that window describes an empty board.
 *
 * So the reads that answer *what is on this board* — `GET /api/elements`, its `search` and its
 * `:id` — wait for the restore before they answer. The three of them and nothing else:
 *
 * - `/health` is not one of them, and case 3 is what says so. It is the readiness probe every
 *   caller and every check in this directory polls, and `core/canvas-client.ts` reads a
 *   non-200 there as a *foreign service on the port* rather than as a canvas still starting —
 *   so making it wait, or answering 503 from it, would refuse the board rather than delay it.
 *   Making the board come up late instead of the read wait is the other way this could have
 *   been "fixed", and it is the one this case rules out.
 * - The writes are not, and that is not an oversight either. A write that lands before the seed
 *   was the worse failure of the two — the store was no longer empty, so `seedBoard` declined to
 *   load over it and returned *before* `persistBoardFor`, which cost the board its saved scene
 *   and its permission to save for the rest of the process — and it was a different decision,
 *   over `PUT`, `DELETE` and the per-second autosync as well. It was taken in **#468**, and not
 *   by putting the writes behind this wait: the seed loads the saved scene underneath whatever
 *   arrived early instead. `scripts/check-board-write-before-restore.mjs` is that half.
 *
 * The cases:
 *
 * 1. **The first read a board ever serves already carries its saved scene.** Not "a read
 *    shortly afterwards": the request is issued from before the port accepts, so it is the
 *    earliest question anything could have asked, and under the old code it is answered with
 *    an empty board every time.
 * 2. **`search` and `:id` answer the same way**, each against its own start — a check that
 *    reused one server would be asking a board that had long since finished reading.
 * 3. **The board still comes up straight away.** `/health` is served while the read of a board
 *    that is still being restored is outstanding, which is the shape of the fix: the read
 *    waits, the server does not.
 * 4. **The wait always ends.** A board with nothing saved has nothing to wait for and answers
 *    an empty scene rather than hanging, and every read above came back well inside the
 *    ceiling the wait is bounded by.
 *
 * Self-contained: throwaway projects in a temp directory, a throwaway registry with saved
 * boards written beside it the way the server derives that directory, its own canvas servers
 * on ports the kernel just handed out, and killed. No browser, and nothing here talks to
 * GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-board-restore-before-read.mjs
 *
 * Tier: fast
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many boards the fixture registers, and how big each saved scene is.
 *
 * Enough that the restore is tens of milliseconds rather than one, so case 3 is comparing two
 * answers that are apart rather than two that are simultaneous. Not more than that on purpose:
 * a scene large enough to be slow is slow because `JSON.parse` blocks the event loop, and a
 * blocked loop delays the very request this check is timing — which would hide the defect
 * instead of exposing it.
 */
const BOARDS = 40;
const PER_BOARD = 200;

/** The board the cases ask about. `p0` is seeded like every other one; nothing favours it. */
const SUBJECT = 'p0';

const workDir = mkdtempSync(join(tmpdir(), 'check-board-restore-'));
const children = [];

/**
 * A registry with `BOARDS` projects, each holding a saved scene, and the id of one element on
 * the subject board that the cases can name.
 *
 * The saved scenes go where `boardStateDir()` puts them — a directory named after the registry
 * file, beside it — rather than somewhere named by `EXCALIDRAW_BOARD_STATE`. It is the
 * derivation that a restart depends on, so it is the derivation this asserts against.
 *
 * The elements are drafts, because a draft is what is lost: it has no issue, no branch and no
 * project item behind it, and the canvas is the only place it exists.
 */
function writeFixture(name, { saved = true } = {}) {
  const root = join(workDir, name);
  const stateDir = join(root, 'workspaces-state');
  mkdirSync(stateDir, { recursive: true });

  const workspaces = [];
  for (let index = 0; index < BOARDS; index++) {
    const id = `p${index}`;
    const projectDir = join(root, id);
    mkdirSync(projectDir, { recursive: true });
    // What registration writes and nothing else: a name, no `board` and no `githubProject`.
    writeFileSync(join(projectDir, 'board.config.json'),
                  JSON.stringify({ name: id }, null, 2), 'utf8');
    workspaces.push({ id, path: projectDir });

    if (!saved) continue;
    const elements = Array.from({ length: PER_BOARD }, (_, at) => ({
      id: `${id}-draft-${at}`,
      type: 'rectangle',
      x: at * 40, y: 0, width: 30, height: 20,
      version: 1,
      strokeColor: '#1e1e1e', backgroundColor: 'transparent',
      fillStyle: 'solid', strokeWidth: 2,
      customData: { kind: 'issue', projectBoardDraft: true, observation: `${id} note ${at}` }
    }));
    writeFileSync(join(stateDir, `${id}.excalidraw`), JSON.stringify({
      type: 'excalidraw', version: 2, source: 'check-board-restore-before-read',
      elements, appState: {}, files: {}
    }), 'utf8');
  }

  const registryPath = join(root, 'workspaces.json');
  writeFileSync(registryPath, JSON.stringify({ workspaces }, null, 2), 'utf8');
  return { registryPath, elementId: `${SUBJECT}-draft-0` };
}

/** A canvas over that registry, on a port the kernel just handed out. */
async function startServer(registryPath) {
  const server = startCanvas({
    port: await freePort(),
    env: {
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, `server-${children.length}.log`),
      EXCALIDRAW_WORKSPACES: registryPath
    }
  });
  children.push(server);
  return server;
}

/**
 * The first answer this server ever gives to `path`, and when it gave it.
 *
 * Spun from before the port accepts rather than after `/health`, with no pause between
 * attempts: a connection refused costs a round trip to the loopback stack and nothing else, so
 * the request lands within a millisecond or two of `listen` — which makes this the earliest
 * question anything could have asked, instead of one asked a health check later.
 */
async function firstServed(base, path, { headers = {}, tries = 60000 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(`${base}${path}`, { headers });
      const body = await response.json();
      return { at: Date.now(), status: response.status, body };
    } catch { /* nothing is listening yet */ }
  }
  throw new Error(`${path} never answered on ${base}`);
}

const draftsIn = (body) => (body?.elements ?? [])
  .filter((element) => element?.customData?.projectBoardDraft === true);

try {
  // ─── 1. The first read carries the saved scene ───────────────

  console.log('1. the first read a restarted board serves already has its saved scene on it');
  {
    const { registryPath, elementId } = writeFixture('first-read');
    const server = await startServer(registryPath);
    const started = Date.now();
    const read = await firstServed(server.base, `/api/elements?workspace=${SUBJECT}`);

    check('the earliest read of the board is answered with the board',
          (read.body?.elements ?? []).length === PER_BOARD,
          `${(read.body?.elements ?? []).length} of ${PER_BOARD} element(s) came back`);
    check('and they are the drafts that were saved, with their observations on them',
          draftsIn(read.body).length === PER_BOARD
            && draftsIn(read.body).every((element) => typeof element.customData?.observation === 'string'),
          `${draftsIn(read.body).length} draft(s)`);
    check('the block the fixture named is one of them',
          (read.body?.elements ?? []).some((element) => element.id === elementId),
          `${elementId} is not among the ${(read.body?.elements ?? []).length} element(s)`);
    check('and the wait it did was a wait, not a hang',
          read.at - started < 20000, `${read.at - started} ms from spawn to the answer`);
  }

  // ─── 2. The other two element reads ──────────────────────────

  console.log('\n2. the same for the other two reads that answer what is on a board');
  {
    const { registryPath } = writeFixture('search-read');
    const server = await startServer(registryPath);
    // Through the header rather than `?workspace=`: everything this route does not name in its
    // own destructuring becomes an exact-match filter on the elements, so a `workspace` in the
    // query would be compared against a field no element has and match nothing. That is #457,
    // and `scripts/check-board-reads-guard.mjs` works around it the same way.
    const read = await firstServed(server.base, '/api/elements/search?type=rectangle',
                                   { headers: { 'x-workspace-id': SUBJECT } });
    check('GET /api/elements/search finds the saved elements on its first answer',
          (read.body?.elements ?? []).length === PER_BOARD,
          `${(read.body?.elements ?? []).length} of ${PER_BOARD} — ${JSON.stringify(read.body).slice(0, 200)}`);
  }
  {
    const { registryPath, elementId } = writeFixture('by-id-read');
    const server = await startServer(registryPath);
    const read = await firstServed(server.base, `/api/elements/${elementId}?workspace=${SUBJECT}`);
    check('GET /api/elements/:id finds a saved element on its first answer',
          read.status === 200 && read.body?.element?.id === elementId,
          `${read.status} ${JSON.stringify(read.body).slice(0, 200)}`);
  }

  // ─── 3. The board still comes up straight away ───────────────

  console.log('\n3. the read waits for the restore; the server does not');
  {
    const { registryPath } = writeFixture('health-first');
    const server = await startServer(registryPath);
    const [health, read] = await Promise.all([
      firstServed(server.base, '/health'),
      firstServed(server.base, `/api/elements?workspace=${SUBJECT}`)
    ]);
    check('/health is answered', health.status === 200 && health.body?.status === 'healthy',
          `${health.status} ${JSON.stringify(health.body?.status)}`);
    check('and it is answered while the read of a board still being restored is outstanding',
          health.at < read.at, `/health at +${health.at - read.at} ms relative to the read`);
    check('the read it beat still came back with the board',
          (read.body?.elements ?? []).length === PER_BOARD,
          `${(read.body?.elements ?? []).length} of ${PER_BOARD}`);
  }

  // ─── 4. A board with nothing saved ───────────────────────────

  console.log('\n4. a board with nothing to restore answers rather than waiting for it');
  {
    const { registryPath } = writeFixture('nothing-saved', { saved: false });
    const server = await startServer(registryPath);
    const started = Date.now();
    const read = await firstServed(server.base, `/api/elements?workspace=${SUBJECT}`);
    check('the read is answered with an empty board',
          read.status === 200 && (read.body?.elements ?? []).length === 0,
          `${read.status} ${(read.body?.elements ?? []).length} element(s)`);
    check('and it did not sit on the ceiling to say so',
          read.at - started < 20000, `${read.at - started} ms from spawn to the answer`);
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const server of children) server.stop();
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

if (failures) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
