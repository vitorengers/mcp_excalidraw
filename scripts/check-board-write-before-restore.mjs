#!/usr/bin/env node
/**
 * Checks that a write landing before the saved boards are back costs the board nothing.
 *
 * `seedBoardsFromFiles` is started from inside the `listen` callback and deliberately not
 * awaited, so for the twenty-odd milliseconds it takes the port is already accepting. #441
 * closed one end of that — the three reads that say *what is on this board* wait for the
 * restore — and said in its own banner that the writes were a separate decision. This is that
 * decision (#468).
 *
 * A write in that window did not merely race the restore, it **cancelled** it. `seedBoard`
 * opens by refusing to load over a store that already holds something, which is right and is
 * the one thing it must never do; what was wrong is that it returned *before*
 * `persistBoardFor`, so all three of these were true afterwards:
 *
 * - the saved scene was never loaded, and the board was the one element that had been written;
 * - nothing drawn on that board for the rest of the process was ever saved, because the
 *   permission every store write is gated on had not been granted;
 * - the file on disk was therefore untouched, so the *next* start brought back the old scene
 *   and silently discarded everything the session did.
 *
 * The autosync is the caller most likely to hit it in the wild: a browser reconnecting to a
 * board that has just restarted syncs its whole scene, every second, and `POST
 * /api/elements/sync` reconciles into the same store.
 *
 * The fix asserted here is that the seed goes *underneath* what is already on the board rather
 * than standing down — the refusal to overwrite is kept, and section 4 is what holds it — and
 * that the permission to save is granted either way. Not that the writes wait: a write delayed
 * behind a restore that has hung pays the ceiling on every request, which on a board syncing
 * once a second is a queue, and it would still leave the ceiling-expired case unfixed.
 *
 * The cases:
 *
 * 1. **The saved scene survives an early write.** The board ends up holding what was saved
 *    *and* what was written, rather than the written element alone.
 * 2. **A board that took such a write is still saved.** The early write reaches the file on
 *    disk without anything else having to happen, and so does the next write after it.
 * 3. **A board with nothing saved yet is saved from then on too.** There is no scene to load
 *    back, so this is the permission on its own, with nothing else standing in for it.
 * 4. **The seed still does not land on top of what was written.** A write that reuses a saved
 *    element's id keeps the written element; the rest of the saved scene comes back around it.
 *
 * The window is real but narrow, so every section starts its own server and confirms it
 * actually raced — the seed says so on the console when it finds a board already written to —
 * and starts another one if it did not. A section that could never win the race says so rather
 * than passing quietly against a board that had finished restoring.
 *
 * Self-contained: throwaway projects in a temp directory, a throwaway registry with saved
 * boards written beside it the way the server derives that directory, its own canvas servers
 * on ports the kernel just handed out, and killed. No browser, and nothing here talks to
 * GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-board-write-before-restore.mjs
 *
 * Tier: fast
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * The same figures as `scripts/check-board-restore-before-read.mjs`, and for the same reason:
 * enough that the restore takes tens of milliseconds rather than one, so a request spun from
 * before the port accepts has somewhere to land — and not more than that, because a scene large
 * enough to be slow is slow because `JSON.parse` blocks the loop, which would delay the very
 * request this is trying to slip in.
 */
const BOARDS = 40;
const PER_BOARD = 200;

/** The board the cases write to. `p0` is seeded like every other one; nothing favours it. */
const SUBJECT = 'p0';

/**
 * What the seed says when it finds a board that was written to before it got there.
 *
 * Both spellings of it: this is the one line that says the race was actually won, and a check
 * that only recognised the fixed server's wording would report "could never race it" against
 * the build it is meant to be red on.
 */
const RACED = new RegExp(`"${SUBJECT}" already holds \\d+ element\\(s\\)`);

/** How long the debounced save may take to reach the disk before the wait is a failure. */
const SAVE_CEILING_MS = 10000;

/** How many servers a section may start looking for the window before it gives up on it. */
const RACE_TRIES = 6;

const workDir = mkdtempSync(join(tmpdir(), 'check-board-write-'));
const children = [];

/**
 * A registry with `BOARDS` projects, each holding a saved scene, and where that scene lives.
 *
 * The saved scenes go where `boardStateDir()` puts them — a directory named after the registry
 * file, beside it — rather than somewhere named by `EXCALIDRAW_BOARD_STATE`. It is the
 * derivation a restart depends on, so it is the derivation this asserts against, and the
 * directory is handed back because half of these cases are about what ends up in it.
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
      type: 'excalidraw', version: 2, source: 'check-board-write-before-restore',
      elements, appState: {}, files: {}
    }), 'utf8');
  }

  const registryPath = join(root, 'workspaces.json');
  writeFileSync(registryPath, JSON.stringify({ workspaces }, null, 2), 'utf8');
  return { registryPath, stateDir, savedFile: join(stateDir, `${SUBJECT}.excalidraw`) };
}

/** A canvas over that registry, on a port the kernel just handed out. */
async function startServer(registryPath) {
  const server = startCanvas({
    port: await freePort(),
    env: {
      HOST: '127.0.0.1',
      EXCALIDRAW_WORKSPACES: registryPath
    }
  });
  children.push(server);
  return server;
}

/**
 * The first answer this server ever gives, and when it gave it.
 *
 * Spun from before the port accepts rather than after `/health`, with no pause between
 * attempts: a connection refused costs a round trip to the loopback stack and nothing else, so
 * the request lands within a millisecond or two of `listen`.
 *
 * A retried `POST` is safe here because every element this check writes carries its own `id`,
 * which `POST /api/elements` honours — a request that died mid-flight and one that was refused
 * both come back to the same element rather than to a second one.
 */
async function firstServed(base, path, { method = 'GET', body = null, headers = {}, tries = 60000 } = {}) {
  const init = body === null
    ? { method, headers }
    : { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(`${base}${path}`, init);
      return { at: Date.now(), status: response.status, body: await response.json() };
    } catch { /* nothing is listening yet */ }
  }
  throw new Error(`${path} never answered on ${base}`);
}

/** A plain rectangle, with the id it is to be found under. */
const rectangle = (id, extra = {}) => ({
  id, type: 'rectangle', x: 4000, y: 4000, width: 50, height: 50, ...extra
});

/**
 * A server whose saved boards came back to a board that had already been written to.
 *
 * The write is spun from before the port accepts, and then the board is read — which waits for
 * the restore, so by the time it answers the seed has either found the write or missed it. The
 * console is what says which: the seed names a board it found already written to. A miss is a
 * fresh fixture and a fresh server rather than a failure, because a check that reported the
 * race it lost as a defect would be red for the machine's timing rather than for the code.
 */
async function racedServer(name, { saved = true, element } = {}) {
  const misses = [];
  for (let attempt = 0; attempt < RACE_TRIES; attempt++) {
    const fixture = writeFixture(`${name}-${attempt}`, { saved });
    const server = await startServer(fixture.registryPath);
    const write = await firstServed(server.base, `/api/elements?workspace=${SUBJECT}`,
                                    { method: 'POST', body: element });
    const read = await firstServed(server.base, `/api/elements?workspace=${SUBJECT}`);

    // The read is answered only once the restore is over, so the line is either already on the
    // console or was never going to be — this is the pipe catching up, not the seed.
    for (let waited = 0; waited < 20 && !RACED.test(server.read()); waited++) await sleep(50);

    if (RACED.test(server.read())) return { server, fixture, write, read, attempt };
    misses.push(`${(read.body?.elements ?? []).length} element(s) on the board`);
    server.stop();
  }
  throw new Error(`${name}: the write never landed inside the restore window in ${RACE_TRIES} `
    + `start(s) — ${misses.join(', ')}`);
}

/** The board as it was last written to disk, once it has been written at all. */
async function savedScene(file, { within = SAVE_CEILING_MS } = {}) {
  const until = Date.now() + within;
  let last = 'it was never written';
  while (Date.now() < until) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      last = error.message;
      await sleep(100);
    }
  }
  throw new Error(`${file} did not become a saved board within ${within} ms — ${last}`);
}

/** The same, but for a board that holds a particular number of elements by then. */
async function savedSceneOf(file, count, { within = SAVE_CEILING_MS } = {}) {
  const until = Date.now() + within;
  let scene = null;
  while (Date.now() < until) {
    try {
      scene = JSON.parse(readFileSync(file, 'utf8'));
      if ((scene.elements ?? []).length === count) return scene;
    } catch { /* half-written, or not there yet */ }
    await sleep(100);
  }
  if (scene) throw new Error(`${file} holds ${(scene.elements ?? []).length} element(s), not ${count}`);
  throw new Error(`${file} did not become a saved board within ${within} ms`);
}

const draftsIn = (elements) => (elements ?? [])
  .filter((element) => element?.customData?.projectBoardDraft === true);

/**
 * One section, with whatever it throws counted as a failure of that section alone.
 *
 * The waits above give up by throwing, and three of the four sections start with one. Left to
 * reach the outer `catch`, the first section to time out would end the run — which against the
 * build this is written to be red on would evidence one section and say nothing about the other
 * three.
 */
async function section(title, run) {
  console.log(title);
  try {
    return await run();
  } catch (error) {
    failures++;
    console.error(`  FAIL  ${error.message}`);
    return null;
  }
}

try {
  // ─── 1. The saved scene survives an early write ──────────────

  let survived = null;
  await section('1. a write that beats the restore does not cost the board its saved scene', async () => {
    const raced = await racedServer('scene-survives', { element: rectangle('written-early') });
    survived = raced;
    const elements = raced.read.body?.elements ?? [];

    check('the earliest write anything could make is served',
          raced.write.status === 200 && raced.write.body?.element?.id === 'written-early',
          `${raced.write.status} ${JSON.stringify(raced.write.body).slice(0, 200)}`);
    check('and the board that took it holds the saved scene as well as the write',
          elements.length === PER_BOARD + 1,
          `${elements.length} element(s), expected ${PER_BOARD + 1}`);
    check('the saved drafts are all back, with their observations on them',
          draftsIn(elements).length === PER_BOARD
            && draftsIn(elements).every((element) => typeof element.customData?.observation === 'string'),
          `${draftsIn(elements).length} of ${PER_BOARD} draft(s)`);
    check('and the element the write created is still one of them',
          elements.some((element) => element.id === 'written-early'),
          `written-early is not among the ${elements.length} element(s)`);
  });

  // ─── 2. And that board is still saved ────────────────────────

  await section('\n2. and the board that took it is still saved for the rest of the process', async () => {
    if (!survived) throw new Error('section 1 never won the race, so there is no board to watch');
    const { server, fixture } = survived;
    const scene = await savedSceneOf(fixture.savedFile, PER_BOARD + 1);
    check('the early write reaches the file with nothing else having to happen',
          (scene.elements ?? []).some((element) => element.id === 'written-early'),
          `${(scene.elements ?? []).length} element(s) saved`);
    check('and the saved scene it landed on is still in there beside it',
          draftsIn(scene.elements).length === PER_BOARD,
          `${draftsIn(scene.elements).length} of ${PER_BOARD} draft(s) saved`);

    const later = await fetch(`${server.base}/api/elements?workspace=${SUBJECT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rectangle('written-later'))
    });
    check('a later write is accepted', later.status === 200, `${later.status}`);
    const after = await savedSceneOf(fixture.savedFile, PER_BOARD + 2);
    check('and it is saved too',
          (after.elements ?? []).some((element) => element.id === 'written-later'),
          `${(after.elements ?? []).length} element(s) saved`);
  });

  // ─── 3. A board with nothing saved yet ───────────────────────

  await section('\n3. a board with nothing saved yet is saved from then on too', async () => {
    const raced = await racedServer('nothing-saved',
                                    { saved: false, element: rectangle('written-onto-nothing') });
    check('the board holds the write and nothing else',
          (raced.read.body?.elements ?? []).length === 1,
          `${(raced.read.body?.elements ?? []).length} element(s)`);
    const scene = await savedScene(raced.fixture.savedFile);
    check('and it is written to the file the next start reads',
          (scene.elements ?? []).some((element) => element.id === 'written-onto-nothing'),
          `${(scene.elements ?? []).length} element(s) saved`);
  });

  // ─── 4. The seed still does not overwrite ────────────────────

  await section('\n4. the saved scene still goes underneath the write, never over it', async () => {
    const collides = `${SUBJECT}-draft-0`;
    const raced = await racedServer('no-overwrite', {
      element: rectangle(collides, { backgroundColor: '#ff0000' })
    });
    const elements = raced.read.body?.elements ?? [];
    const written = elements.find((element) => element.id === collides);

    check('the element the write created is the one the board kept',
          written?.backgroundColor === '#ff0000' && written?.customData === undefined,
          `${JSON.stringify(written).slice(0, 200)}`);
    check('and the rest of the saved scene came back around it',
          elements.length === PER_BOARD && draftsIn(elements).length === PER_BOARD - 1,
          `${elements.length} element(s), ${draftsIn(elements).length} draft(s)`);
  });
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
