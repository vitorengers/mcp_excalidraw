#!/usr/bin/env node
/**
 * `GET /api/elements/search` must read the workspace as the board, not as a filter.
 *
 * That route takes every query parameter it does not recognise and requires the elements it
 * answers with to carry a property of that name and that value. `workspace` is one of the three
 * spellings `workspaceIdFrom()` accepts, so the query form was read twice: the board was
 * resolved correctly and then every element on it was required to have a `workspace` property.
 * None does, so `?workspace=X` answered an empty board while the very same request spelled
 * `x-workspace-id: X` answered the whole of it (#457). Nothing in the frontend calls this route,
 * which is what kept it quiet — but `core/canvas-client.ts` appends `?workspace=` to every path
 * it requests, so the MCP `query_elements` tool and `elements query` on the CLI both went
 * through the broken spelling and both answered nothing.
 *
 * `token` is the same shape one door along: the board token may be offered as `?token=` on any
 * request, so a caller that authenticates that way rather than by header was filtering on it too.
 * Both names are excluded here, and section 5 is the second one.
 *
 * What the exclusion costs is exactly nothing: a stored element has no `workspace` or `token`
 * field to filter on — the workspace is which `Map` the element is in, not something written on
 * it. So section 3 is the other half of this check and the more important one: the arbitrary
 * field filtering the route exists for still works, and a filter that should match nothing still
 * matches nothing, which is what stops "excluded the reserved names" from becoming "stopped
 * filtering".
 *
 * Self-contained: with no arguments it starts its own canvas servers on ports the kernel just
 * handed out, gives them a throwaway home so nothing is read out of or written into the
 * operator's own state directory, and kills them. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-search-workspace.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workdir = mkdtempSync(join(tmpdir(), 'check-search-workspace-'));
const fakeHome = join(workdir, 'home');
mkdirSync(fakeHome, { recursive: true });

/**
 * Where a server started here writes its token, spelled out from the platform rather than asked
 * of the code under test — the same three answers `stateDir()` gives, as `check-token-auth.mjs`
 * and `check-board-reads-guard.mjs` spell them.
 */
function conventionalTokenFile(port) {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const home = process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Application Support')
    : fakeHome;
  return join(home, leaf, `server-${port}.token`);
}

/** The home goes to every server here, so no board of the operator's is read or written. */
const HOME_ENV = {
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  LOCALAPPDATA: fakeHome,
  XDG_STATE_HOME: fakeHome,
};

async function waitForHealth(base, child) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error('the canvas server exited early');
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}`);
}

/** The board this check writes to, named the way a caller names it. */
const BOARD = 'searched';

/** The elements seeded onto it, and what each one is here to be found — or not found — by. */
const SEED = [
  { id: 'seed-wide-rectangle', type: 'rectangle', x: 10, y: 10, width: 40, height: 20,
    strokeColor: '#111111' },
  { id: 'seed-far-rectangle', type: 'rectangle', x: 900, y: 900, width: 40, height: 20,
    strokeColor: '#222222' },
  { id: 'seed-ellipse', type: 'ellipse', x: 20, y: 20, width: 30, height: 30,
    strokeColor: '#111111' },
];

/** One element on the `default` store, so "answered the right board" is not "answered any board". */
const DEFAULT_ONLY_ID = 'seed-on-the-default-board';

let server;
let authed;

try {
  const port = await freePort();
  server = startCanvas({ port, cwd: workdir, env: { LOG_LEVEL: 'error', ...HOME_ENV } });
  await waitForHealth(server.base, server.child);

  const get = async (path, headers = {}) => {
    const response = await fetch(`${server.base}${path}`, { headers });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, text, json };
  };

  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${server.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
    return response.json();
  };

  const idsOf = (answer) => (answer.json?.elements ?? []).map((element) => element.id).sort();

  for (const element of SEED) await post(`/api/elements?workspace=${BOARD}`, element);
  await post('/api/elements', {
    id: DEFAULT_ONLY_ID, type: 'rectangle', x: 0, y: 0, width: 5, height: 5,
  });

  const SEEDED = SEED.map((element) => element.id).sort();

  // ─── 1. The two spellings are the same request ───

  console.log('\n1. the query spelling answers the board the header spelling answers');
  const byHeader = await get('/api/elements/search', { 'x-workspace-id': BOARD });
  const byQuery = await get(`/api/elements/search?workspace=${BOARD}`);

  // First, that the header form found anything at all: two empty answers agree with each other
  // perfectly, and that agreement is the defect rather than the fix.
  check('the header spelling answers with the whole board',
        JSON.stringify(idsOf(byHeader)) === JSON.stringify(SEEDED),
        `got ${JSON.stringify(idsOf(byHeader))}`);
  check('the query spelling answers with the same elements',
        JSON.stringify(idsOf(byQuery)) === JSON.stringify(idsOf(byHeader)),
        `query=${JSON.stringify(idsOf(byQuery))} header=${JSON.stringify(idsOf(byHeader))}`);
  check('and the count it reports agrees with what it sent',
        byQuery.json?.count === (byQuery.json?.elements ?? []).length,
        `count=${byQuery.json?.count}`);

  // ─── 2. It is that board, and not merely some board ───

  console.log('\n2. and it is that board, not the default one');
  check('the named board does not carry the default board\'s element',
        !idsOf(byQuery).includes(DEFAULT_ONLY_ID), JSON.stringify(idsOf(byQuery)));
  const unnamed = await get('/api/elements/search');
  check('naming no board still answers the default one',
        idsOf(unnamed).includes(DEFAULT_ONLY_ID), JSON.stringify(idsOf(unnamed)));
  const unknown = await get('/api/elements/search?workspace=a-board-nobody-drew-on');
  check('a board nothing was ever written to answers empty',
        (unknown.json?.elements ?? []).length === 0, unknown.text.slice(0, 160));

  // ─── 3. The filtering the route is for still filters ───

  console.log('\n3. the filtering this route exists for still works, both spellings');
  const ellipses = await get(`/api/elements/search?workspace=${BOARD}&type=ellipse`);
  check('type narrows to the one ellipse',
        JSON.stringify(idsOf(ellipses)) === JSON.stringify(['seed-ellipse']),
        JSON.stringify(idsOf(ellipses)));

  const near = await get(`/api/elements/search?workspace=${BOARD}&x_min=0&x_max=100`);
  check('a bounding box drops the element outside it',
        JSON.stringify(idsOf(near)) === JSON.stringify(['seed-ellipse', 'seed-wide-rectangle']),
        JSON.stringify(idsOf(near)));

  const stroked = await get(
    `/api/elements/search?workspace=${BOARD}&strokeColor=${encodeURIComponent('#222222')}`);
  check('an arbitrary field is still an exact-match filter',
        JSON.stringify(idsOf(stroked)) === JSON.stringify(['seed-far-rectangle']),
        JSON.stringify(idsOf(stroked)));

  // The one that stops "reserved names are excluded" from quietly becoming "filters are
  // ignored": a filter nothing satisfies has to still answer with nothing.
  const nothing = await get(
    `/api/elements/search?workspace=${BOARD}&strokeColor=${encodeURIComponent('#c0ffee')}`);
  check('a filter nothing satisfies still answers empty',
        (nothing.json?.elements ?? []).length === 0, nothing.text.slice(0, 160));

  const byHeaderFiltered = await get('/api/elements/search?type=ellipse',
                                     { 'x-workspace-id': BOARD });
  check('the header spelling filters identically',
        JSON.stringify(idsOf(byHeaderFiltered)) === JSON.stringify(idsOf(ellipses)),
        JSON.stringify(idsOf(byHeaderFiltered)));

  // ─── 4. The other route that already agreed, as the control ───

  console.log('\n4. and it agrees with the route beside it, which never had the defect');
  const plain = await get(`/api/elements?workspace=${BOARD}`);
  check('GET /api/elements answers the same board for the same query spelling',
        JSON.stringify(idsOf(plain)) === JSON.stringify(SEEDED),
        JSON.stringify(idsOf(plain)));

  // ─── 5. The token is reserved on this route for the same reason ───

  console.log('\n5. and a caller that carries the board token in the query is not filtered by it');
  const authedPort = await freePort();
  authed = startCanvas({
    port: authedPort,
    cwd: workdir,
    env: {
      LOG_LEVEL: 'error',
      ...HOME_ENV,
      // `canvasEnvironment` turns the token off for every check in this directory. This one
      // server takes it back on, because `?token=` only exists where the gate does.
      EXCALIDRAW_NO_AUTH: undefined,
    },
  });
  await waitForHealth(authed.base, authed.child);

  const tokenFile = conventionalTokenFile(authedPort);
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  check('this start wrote a token, so the query spelling below is a real one', token.length > 0,
        tokenFile);

  const authedGet = async (path, headers = {}) => {
    const response = await fetch(`${authed.base}${path}`, { headers });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, text, json };
  };

  const seededId = 'seed-behind-the-token';
  const created = await fetch(`${authed.base}/api/elements?workspace=${BOARD}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vibemaxxing-token': token },
    body: JSON.stringify({ id: seededId, type: 'rectangle', x: 1, y: 1, width: 5, height: 5 }),
  });
  check('the gate is on, and this check is through it', created.ok, `HTTP ${created.status}`);

  // Both names in headers first, for the reason section 1 takes the header first: it is the
  // control, and two empty answers agree with one another perfectly. Then one name moves into
  // the query at a time, so a failure below names which of the two was read twice.
  const bothHeaders = await authedGet('/api/elements/search',
                                      { 'x-workspace-id': BOARD, 'x-vibemaxxing-token': token });
  check('with both names in headers the search answers the board',
        JSON.stringify(idsOf(bothHeaders)) === JSON.stringify([seededId]),
        `HTTP ${bothHeaders.status} — ${bothHeaders.text.slice(0, 160)}`);

  const tokenInQuery = await authedGet(
    `/api/elements/search?token=${encodeURIComponent(token)}`, { 'x-workspace-id': BOARD });
  check('and moving only the token into the query answers the same',
        JSON.stringify(idsOf(tokenInQuery)) === JSON.stringify(idsOf(bothHeaders)),
        `HTTP ${tokenInQuery.status} — ${tokenInQuery.text.slice(0, 160)}`);

  const bothInQuery = await authedGet(
    `/api/elements/search?workspace=${BOARD}&token=${encodeURIComponent(token)}`);
  check('and so does the request that carries both of them there',
        JSON.stringify(idsOf(bothInQuery)) === JSON.stringify(idsOf(bothHeaders)),
        `HTTP ${bothInQuery.status} — ${bothInQuery.text.slice(0, 160)}`);

  const refused = await authedGet(`/api/elements/search?workspace=${BOARD}&token=not-the-token`);
  check('a wrong token is still refused, so the exclusion is not a way past the gate',
        refused.status === 401, `HTTP ${refused.status} — ${refused.text.slice(0, 160)}`);
} catch (error) {
  failures++;
  console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`);
  if (server && process.env.DEBUG_SEARCH_WORKSPACE) console.error(server.read());
  if (authed && process.env.DEBUG_SEARCH_WORKSPACE) console.error(authed.read());
} finally {
  server?.stop();
  authed?.stop();
  await sleep(200);
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
