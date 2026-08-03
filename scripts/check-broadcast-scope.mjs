#!/usr/bin/env node
/**
 * Every element and file event on the socket names the board it happened on.
 *
 * `broadcast` states its own rule above itself in `src/server.ts`: omitting the workspace
 * reaches every client, which is right for a server-wide notice and wrong for anything about
 * one board's shapes or one board's images. Three calls omitted it — `elements_synced`,
 * `files_added` and `file_deleted` — while `canvas_cleared`, thirty lines above the first of
 * them, passed one all along.
 *
 * `files_added` is the one with teeth. It carries dataURLs and the client applies them
 * unconditionally through `excalidrawAPI.addFiles`, so an image pasted on one project was
 * pushed into every other project open in the same browser (#526). It is also the frame a
 * forwarder would have no basis on which to route the day a socket crosses a network: a frame
 * with no board on it leaves a relay choosing between dropping it and fanning it wider than it
 * goes today, and neither of those is a behaviour anybody decided.
 *
 * Three sections, and the second is what stops the first passing for the wrong reason:
 *
 *  1. **the defect.** Two raw sockets, one declaring board A and one declaring board B; A is
 *     written to over HTTP and B's socket must see none of the three types — asserted by the
 *     file id and not by counting frames, because a count cannot tell an image apart from an
 *     unrelated notice.
 *  2. **the control.** A's own socket sees all three. A relay that simply stopped broadcasting
 *     would pass section 1 perfectly.
 *  3. **the background board.** `applyToWarmBoard` in `frontend/src/App.tsx` is the listener a
 *     board off screen gets, and it is deliberately only the messages that are about shapes. Its
 *     `case` labels are read out of that file rather than copied here, and every one of them has
 *     to still arrive at a socket on the board it happened on — so a scoping change cannot
 *     quietly take a message type away from a background board, and a new case added there with
 *     no producer here fails this check rather than going unwatched.
 *
 * The negative assertions are made only after A's socket has seen all three, so that "B did not
 * receive it" cannot be "B has not received it yet": both sockets are served in the same loop
 * over the same client set, so anything B was going to be sent had been sent by then.
 *
 * Self-contained: it writes a throwaway registry with two projects in a temporary directory,
 * starts its own canvas on a port the kernel hands it and kills it. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-broadcast-scope.mjs
 *
 * Tier: fast
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { openCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => value.replace(/\\/g, '/');

const A = 'board-a';
const B = 'board-b';

// A real one-pixel PNG, because the point of `files_added` is that it carries the bytes.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FILE_ON_A = 'file-that-belongs-to-board-a';

const workDir = mkdtempSync(join(tmpdir(), 'check-broadcast-scope-'));
const projectA = join(workDir, A);
const projectB = join(workDir, B);
mkdirSync(projectA, { recursive: true });
mkdirSync(projectB, { recursive: true });
writeFileSync(join(projectA, 'board.config.json'), JSON.stringify({ name: 'Board A' }), 'utf8');
writeFileSync(join(projectB, 'board.config.json'), JSON.stringify({ name: 'Board B' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: A, path: slash(projectA) },
    { id: B, path: slash(projectB) },
  ],
}), 'utf8');

const canvas = await openCanvas({
  env: { EXCALIDRAW_WORKSPACES: registryPath, LOG_LEVEL: 'error' },
});
const BASE = canvas.base;

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/**
 * A socket standing in for a tab open on one board.
 *
 * It keeps every frame whole rather than a set of types, because the assertion that matters is
 * about a file id inside a frame and not about how many frames arrived.
 */
async function watch(workspace) {
  const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?workspace=${workspace}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const received = [];
  socket.on('message', (raw) => {
    try { received.push(JSON.parse(raw.toString())); } catch { /* not ours */ }
  });
  return {
    received,
    seen: (type) => received.some((message) => message?.type === type),
    names: (id) => received.some((message) => JSON.stringify(message).includes(id)),
    types: () => [...new Set(received.map((message) => message?.type))].join(', '),
    close: () => { try { socket.close(); } catch { /* already gone */ } },
  };
}

async function waitUntil(condition, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(25);
  }
  return false;
}

/**
 * The message types a background board applies, read from the file that applies them.
 *
 * Copied here they would say what this check remembers; read from there they say what the
 * frontend does, which is the claim being made.
 */
function warmBoardCaseList() {
  const source = readFileSync(join(repoRoot, 'frontend', 'src', 'App.tsx'), 'utf8');
  const from = source.indexOf('const applyToWarmBoard =');
  if (from === -1) throw new Error('applyToWarmBoard is no longer in frontend/src/App.tsx');
  const to = source.indexOf('const watchInBackground =', from);
  if (to === -1) throw new Error('could not find the end of applyToWarmBoard');
  const cases = [...source.slice(from, to).matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]);
  if (!cases.length) throw new Error('applyToWarmBoard has no cases left in it');
  return cases;
}

async function main() {
  console.log(`canvas: ${BASE}`);

  const watcherA = await watch(A);
  const watcherB = await watch(B);

  try {
    // Everything below happens on board A and names board A. Board B is written to exactly
    // once, before any of it, so that the two boards are not distinguishable by one of them
    // being empty.
    await api(`/api/elements?workspace=${B}`, {
      method: 'POST',
      body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }),
    });

    await api(`/api/files?workspace=${A}`, {
      method: 'POST',
      body: JSON.stringify({ files: [{ id: FILE_ON_A, dataURL: PIXEL, mimeType: 'image/png' }] }),
    });
    await api(`/api/elements/sync?workspace=${A}`, {
      method: 'POST',
      body: JSON.stringify({
        elements: [{
          id: 'synced-onto-board-a', type: 'rectangle', x: 0, y: 0, width: 5, height: 5,
          version: 1, versionNonce: 1, isDeleted: false,
        }],
        timestamp: new Date().toISOString(),
      }),
    });
    await api(`/api/files/${FILE_ON_A}?workspace=${A}`, { method: 'DELETE' });

    // The board the events happened on is served first, so the negative assertions below are
    // about frames that were sent and not about frames still in flight.
    const arrived = await waitUntil(() => watcherA.seen('files_added')
      && watcherA.seen('elements_synced') && watcherA.seen('file_deleted'));

    console.log('\n1. a board is not told what happened on another board');
    check('B was not handed A\'s image', !watcherB.seen('files_added'),
          `B received: ${watcherB.types()}`);
    check('and no frame B received names the file id at all', !watcherB.names(FILE_ON_A),
          'an image pasted on one project reached every other project open in the browser');
    check('B was not told A had been synced', !watcherB.seen('elements_synced'),
          `B received: ${watcherB.types()}`);
    check('B was not told A\'s image had been deleted', !watcherB.seen('file_deleted'),
          `B received: ${watcherB.types()}`);

    console.log('\n2. and the board it did happen on is still told all three');
    check('the three frames reached A', arrived, `A received: ${watcherA.types()}`);
    check('A was handed the image', watcherA.seen('files_added'), `A received: ${watcherA.types()}`);
    check('and the frame names the file id', watcherA.names(FILE_ON_A));
    check('A was told it had been synced', watcherA.seen('elements_synced'),
          `A received: ${watcherA.types()}`);
    check('A was told the image was deleted', watcherA.seen('file_deleted'),
          `A received: ${watcherA.types()}`);
    check('every frame A received about its own board names it',
          watcherA.received
            .filter((message) => ['files_added', 'file_deleted', 'elements_synced'].includes(message?.type))
            .every((message) => message.workspace === A),
          JSON.stringify(watcherA.received.map((message) => [message?.type, message?.workspace])));

    console.log('\n3. a board off screen still receives every message it applies');
    const cases = warmBoardCaseList();
    console.log(`  applyToWarmBoard applies: ${cases.join(', ')}`);

    // A socket opened now, so that `initial_elements` — the one the server sends to the socket
    // itself rather than broadcasting — is observed the way a background board observes it.
    const warm = await watch(A);
    try {
      const created = await api(`/api/elements?workspace=${A}`, {
        method: 'POST',
        body: JSON.stringify({ type: 'rectangle', x: 1, y: 1, width: 10, height: 10 }),
      });
      const createdId = created.element.id;
      await api(`/api/elements/${createdId}?workspace=${A}`, {
        method: 'PUT',
        body: JSON.stringify({ x: 99 }),
      });
      await api(`/api/elements/batch?workspace=${A}`, {
        method: 'POST',
        body: JSON.stringify({ elements: [{ type: 'ellipse', x: 2, y: 2, width: 4, height: 4 }] }),
      });
      await api(`/api/files?workspace=${A}`, {
        method: 'POST',
        body: JSON.stringify({ files: [{ id: 'file-for-the-warm-board', dataURL: PIXEL }] }),
      });
      await api(`/api/elements/${createdId}?workspace=${A}`, { method: 'DELETE' });
      await api(`/api/elements/clear?workspace=${A}`, { method: 'DELETE' });

      for (const type of cases) {
        const reached = await waitUntil(() => warm.seen(type), 2000);
        check(`a board on A still receives ${type}`, reached, `it received: ${warm.types()}`);
      }
    } finally {
      warm.close();
    }
  } finally {
    watcherA.close();
    watcherB.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  failures++;
} finally {
  canvas.stop();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds files */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
