#!/usr/bin/env node
/**
 * Isolation checks for workspace-scoped element storage.
 *
 * Elements lived in one module-level Map. Making it per-workspace touches every read
 * and write in the server, and a single missed call site silently crosses boards —
 * the same class of data loss as the clear-and-replace sync fixed in #1, and just as
 * invisible. Every case here writes to one workspace and asserts another is untouched.
 *
 * Section 8 is the other half of the same class, and it is not about the store at all:
 * two routes ask the *browser* to do something — move its camera, render an image — and
 * both used to broadcast with no workspace at all, so a request naming one board reached
 * every board open in every window (#156).
 *
 * Usage: node scripts/check-workspace-isolation.mjs [--url http://127.0.0.1:3000]
 * Expects an empty canvas.
 */

import WebSocket from 'ws';

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg !== -1 && process.argv[urlArg + 1])
  || process.env.EXPRESS_SERVER_URL
  || 'http://127.0.0.1:3000';

const A = 'alpha';
const B = 'beta';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const listIn = async (ws) => (await api(`/api/elements?workspace=${ws}`)).elements;
const countIn = async (ws) => (await listIn(ws)).length;

const createIn = (ws, overrides = {}) =>
  api(`/api/elements?workspace=${ws}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 10, height: 10, ...overrides }),
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(50);
  }
  return false;
}

/**
 * A socket standing in for a tab open on one board.
 *
 * The routes under test do not answer over HTTP with what they did; they ask the browser,
 * over the socket, and the whole question here is which browsers were asked. So the stand-in
 * only has to record what arrived.
 */
async function watch(workspace) {
  const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/?workspace=${workspace}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const received = [];
  const listeners = new Map();
  socket.on('message', (raw) => {
    let message = null;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    received.push(message);
    listeners.get(message?.type)?.(message);
  });
  return {
    seen: (type) => received.some((message) => message?.type === type),
    on: (type, handler) => listeners.set(type, handler),
    close: () => { try { socket.close(); } catch { /* already gone */ } },
  };
}

const syncIn = (ws, elements) =>
  api(`/api/elements/sync?workspace=${ws}`, {
    method: 'POST',
    body: JSON.stringify({ elements, timestamp: new Date().toISOString() }),
  });

async function main() {
  console.log(`canvas: ${BASE}`);

  console.log('\n1. creating in one workspace does not leak into another');
  const inA = await createIn(A, { x: 100 });
  check('A has the element', (await countIn(A)) === 1, `A=${await countIn(A)}`);
  check('B stays empty', (await countIn(B)) === 0, `B=${await countIn(B)}`);

  console.log('\n2. the same id can exist independently in both');
  const sharedId = 'shared-id';
  await createIn(A, { id: sharedId, x: 1 });
  await createIn(B, { id: sharedId, x: 2 });
  const fromA = (await api(`/api/elements/${sharedId}?workspace=${A}`)).element;
  const fromB = (await api(`/api/elements/${sharedId}?workspace=${B}`)).element;
  check('A keeps its own copy', fromA.x === 1, `x=${fromA.x}`);
  check('B keeps its own copy', fromB.x === 2, `x=${fromB.x}`);

  console.log('\n3. update in one workspace leaves the other alone');
  await api(`/api/elements/${sharedId}?workspace=${A}`, {
    method: 'PUT',
    body: JSON.stringify({ x: 42 }),
  });
  const afterA = (await api(`/api/elements/${sharedId}?workspace=${A}`)).element;
  const afterB = (await api(`/api/elements/${sharedId}?workspace=${B}`)).element;
  check('A updated', afterA.x === 42, `x=${afterA.x}`);
  check('B unchanged', afterB.x === 2, `x=${afterB.x}`);

  console.log('\n4. delete in one workspace leaves the other alone');
  await api(`/api/elements/${sharedId}?workspace=${A}`, { method: 'DELETE' });
  const stillInB = (await listIn(B)).some((e) => e.id === sharedId);
  check('gone from A', !(await listIn(A)).some((e) => e.id === sharedId));
  check('still in B', stillInB);

  console.log('\n5. autosync is the dangerous one: it must not touch the other board');
  const bBefore = await countIn(B);
  await syncIn(A, [{
    id: 'from-browser', type: 'rectangle', x: 0, y: 0, width: 5, height: 5,
    version: 1, versionNonce: 1, isDeleted: false,
  }]);
  check('A received the synced element', (await listIn(A)).some((e) => e.id === 'from-browser'));
  check('B untouched by A\'s sync', (await countIn(B)) === bBefore, `B=${await countIn(B)}`);
  check('A kept its pre-existing element', (await listIn(A)).some((e) => e.id === inA.element.id));

  console.log('\n6. clear wipes one workspace only');
  await api(`/api/elements/clear?workspace=${A}`, { method: 'DELETE' });
  check('A empty', (await countIn(A)) === 0, `A=${await countIn(A)}`);
  check('B survived', (await countIn(B)) > 0, `B=${await countIn(B)}`);

  console.log('\n7. omitting the workspace uses the default store, not a random one');
  const noWorkspace = (await api('/api/elements')).elements;
  check('default store is separate from A and B', !noWorkspace.some((e) => e.id === sharedId));

  await api(`/api/elements/clear?workspace=${B}`, { method: 'DELETE' });

  console.log('\n8. what the browser is *asked to do* is scoped to a board too');
  const watcherA = await watch(A);
  const watcherB = await watch(B);
  try {
    // The camera. Answered by the watcher standing in for A's tab, so the route resolves
    // the way it would with a real one rather than only after its ten-second timeout.
    watcherA.on('set_viewport', (message) => {
      void api('/api/viewport/result', {
        method: 'POST',
        body: JSON.stringify({ requestId: message.requestId, success: true }),
      }).catch(() => { /* the assertions below are what matters */ });
    });
    await api(`/api/viewport?workspace=${A}`, {
      method: 'POST',
      body: JSON.stringify({ scrollToContent: true }),
    });
    check('A was asked to move its camera', watcherA.seen('set_viewport'));
    check('B was not', !watcherB.seen('set_viewport'),
          'a viewport request named A and moved every board open in every window');

    // The export. Sent 800 ms after the request, and left to time out rather than
    // answered: what is being asked is who it reached, not what came back.
    const abort = new AbortController();
    const exporting = api(`/api/export/image?workspace=${A}`, {
      method: 'POST',
      body: JSON.stringify({ format: 'png' }),
      signal: abort.signal,
    }).catch(() => ({}));
    await waitUntil(() => watcherA.seen('export_image_request'), 4000);
    check('A was asked to render', watcherA.seen('export_image_request'));
    check('B was not', !watcherB.seen('export_image_request'),
          'an export of one board made every other board answer with its own scene');
    abort.abort();
    await exporting;

    // Nobody is watching this one, so there is no tab that could answer. Refusing says so
    // at once; broadcasting to everyone would have had another board answer for it.
    let refused = null;
    try {
      await api('/api/export/image?workspace=gamma', {
        method: 'POST',
        body: JSON.stringify({ format: 'png' }),
      });
    } catch (error) { refused = error.message; }
    check('an export for a board no tab is on is refused, not handed to another board',
          refused !== null && /503/.test(refused), String(refused));
  } finally {
    watcherA.close();
    watcherB.close();
  }

  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
}

main().catch((err) => { console.error(`\nerror: ${err.message}`); process.exit(1); });
