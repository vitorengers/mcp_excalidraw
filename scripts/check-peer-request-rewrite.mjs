#!/usr/bin/env node
/**
 * Checks what one board's request says by the time it is the peer's.
 *
 * `core/peer-client.ts` performs the call; this is the decision about what the call says, and
 * every one of the four things it has to get right breaks a board quietly rather than loudly.
 *
 *   - **the workspace key is translated.** The local namespaced id goes out as the peer's own
 *     spelling. The peer runs `normalizeWorkspaceId` on whatever arrives and rewrites anything
 *     it dislikes to the literal id `default`, so a wrong spelling here does not error — it
 *     answers from a board nobody named;
 *   - **it is read from all three places the server reads it.** `workspaceIdFrom` takes
 *     `query.workspace`, then a body field, then `x-workspace-id`, and the MCP server, the CLI
 *     and about twenty checks in this directory use the header form. So the same request is
 *     driven through this file **three ways**, and all three have to produce the *identical*
 *     outbound request — asserted on the rendered request, not on the workspace id alone;
 *   - **the credential is replaced, not appended.** The local token comes out of both spellings,
 *     the header and `?token=`, and the device credential goes in. A request carrying two is a
 *     request the peer gets to choose between, and which one it picks is `offeredToken`'s
 *     ordering rather than anybody's decision;
 *   - **`x-client-id` survives verbatim.** `broadcast`'s third argument excludes the socket whose
 *     id matches, so a substituted one gets the reader its own writes echoed back a debounce
 *     later, which is #190 exactly. Asserted on the exact string rather than on its presence.
 *
 * And two refusals, because a rewriter that will rewrite anything handed to it is one bug away
 * from forwarding `POST /api/restart` — which ends the process and every agent it hosts,
 * whichever board asked. The paths that describe *this* machine are refused by name, and a
 * request naming one of this board's own projects is refused rather than sent anywhere.
 *
 * The assertions that matter are made against the **compiled** `workspaceIdFrom` and
 * `normalizeWorkspaceId` rather than against a restatement of them here: the outbound request is
 * fed back through the reader the peer really runs, and required to name the peer's own board.
 *
 * Self-contained: it drives compiled modules and starts nothing. No server, no browser.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-peer-request-rewrite.mjs
 *
 * Tier: fast
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** What the other board's normaliser rewrites everything it dislikes to. */
const COLLAPSE_TARGET = 'default';

// ─── 0. The modules, and what this one is allowed to know ─────────────────────

console.log('0. the module is pure, and it asks the real reader rather than restating it');

const modulePath = join(repoRoot, 'dist', 'core', 'peer-request-rewrite.js');
const storePath = join(repoRoot, 'dist', 'core', 'element-store.js');
const idPath = join(repoRoot, 'dist', 'core', 'remote-workspace-id.js');
const tokenPath = join(repoRoot, 'dist', 'core', 'board-token.js');
const sourcePath = join(repoRoot, 'src', 'core', 'peer-request-rewrite.ts');

for (const [what, where] of [
  ['peer-request-rewrite', modulePath],
  ['element-store', storePath],
  ['remote-workspace-id', idPath],
  ['board-token', tokenPath]
]) {
  if (!existsSync(where)) {
    console.error(`  FAIL  dist/core/${what}.js exists — run ./node_modules/.bin/tsc first`);
    process.exit(1);
  }
}

const module = await import(pathToFileURL(modulePath).href);
const store = await import(pathToFileURL(storePath).href);
const { workspaceIdFrom, normalizeWorkspaceId, WORKSPACE_QUERY_KEYS } = store;
const { mintRemoteWorkspaceId } = await import(pathToFileURL(idPath).href);
const { TOKEN_HEADER, TOKEN_QUERY } = await import(pathToFileURL(tokenPath).href);

const { rewriteRequestForPeer, remoteBoardOf, pathStaysHere } = module;
const { HOP_BY_HOP_HEADERS, PATHS_THAT_STAY_HERE } = module;

check('core/peer-request-rewrite exports rewriteRequestForPeer',
      typeof rewriteRequestForPeer === 'function', `got ${typeof rewriteRequestForPeer}`);
check('and remoteBoardOf, so a caller can find the peer before it rewrites',
      typeof remoteBoardOf === 'function', `got ${typeof remoteBoardOf}`);
check('and pathStaysHere, so the paths that describe this machine are askable',
      typeof pathStaysHere === 'function', `got ${typeof pathStaysHere}`);

if (typeof rewriteRequestForPeer !== 'function') {
  console.error('\nthe module does not export the rewriter; nothing below can be asserted');
  process.exit(1);
}

const source = readFileSync(sourcePath, 'utf8');

check('it reads the workspace with the compiled workspaceIdFrom, not a re-implementation',
      /import\s*\{[^}]*workspaceIdFrom[^}]*\}\s*from\s*'\.\/element-store\.js'/.test(source),
      'the assertion has to be made against the reader the server really runs');
check('and it names the two token spellings from board-token rather than typing them again',
      /import\s*\{[^}]*TOKEN_HEADER[^}]*\}\s*from\s*'\.\/board-token\.js'/.test(source)
        && /TOKEN_QUERY/.test(source),
      'a header the page sends and the server does not read compiles perfectly');
check('it reads no file',
      !/from '(node:)?fs'/.test(source) && !/readFileSync|writeFileSync|fs\.promises/.test(source));
check('it opens no socket, and there is no fetch in it',
      !/from '(node:)?(net|http|https|ws)'/.test(source)
        && !/createConnection|fetch\(|\.request\(/.test(source));
check('it reads no process.env', !/process\.env\s*[.[]/.test(source));
check('and it touches no element store or board state',
      !/elementsFor|activeWorkspaceIds|boardState/.test(source),
      'this module decides what a call says and holds nothing');

check('the list of what crosses is peer-client\'s rather than a second copy of it',
      /import\s*\{[^}]*PEER_HEADERS_THAT_CROSS[^}]*\}\s*from\s*'\.\/peer-client\.js'/.test(source),
      'a second list is the one that stops being updated');

check('the hop-by-hop list is stated in the module rather than assumed from memory',
      Array.isArray(HOP_BY_HOP_HEADERS) && HOP_BY_HOP_HEADERS.length >= 8,
      JSON.stringify(HOP_BY_HOP_HEADERS));
for (const name of [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]) {
  check(`  ${name} is on it`, (HOP_BY_HOP_HEADERS ?? []).includes(name),
        JSON.stringify(HOP_BY_HOP_HEADERS));
}

// ─── The fixture: one peer, one project, and a local id minted for real ───────

/** This board's name for the machine, and that machine's own name for the project. */
const PEER_ID = 'mac';
const PEER_WORKSPACE = 'field-notes';

const mint = mintRemoteWorkspaceId(PEER_ID, PEER_WORKSPACE);
check('the fixture local id is one the id module really mints', mint.ok === true,
      JSON.stringify(mint));
if (!mint.ok) { console.error('\nno local id to drive with'); process.exit(1); }

/** What this board calls the peer's project. It must appear nowhere on the wire. */
const LOCAL_ID = mint.id;

/** This server's own secret, in both the spellings a caller may offer it in. */
const LOCAL_TOKEN = 'local-board-token-1a2b3c';
/** The credential the peer minted for this machine. The only one that may cross. */
const PEER_SECRET = 'peer-device-secret-9z8y7x';
/** Mixed case and an underscore on purpose: `broadcast` compares the exact string. */
const CLIENT_ID = 'Client_7F3a-b2';

const PEER = { peerId: PEER_ID, secret: PEER_SECRET };

/** How express hands a query string to `workspaceIdFrom`: one value, or an array of them. */
function queryRecordOf(search) {
  const params = new URLSearchParams(search);
  const record = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    record[key] = all.length === 1 ? all[0] : all;
  }
  return record;
}

/** The outbound request as the peer's own reader would see it. */
function asThePeerReadsIt(request) {
  const cut = request.path.indexOf('?');
  return workspaceIdFrom({
    query: queryRecordOf(cut === -1 ? '' : request.path.slice(cut + 1)),
    headers: request.headers,
    body: request.body === undefined ? undefined : JSON.parse(request.body.toString('utf8'))
  });
}

/** One string for a whole outbound request, with the header order taken out of it. */
function render(request) {
  const headers = {};
  for (const name of Object.keys(request.headers ?? {}).sort()) headers[name] = request.headers[name];
  return JSON.stringify({
    method: request.method,
    path: request.path,
    headers,
    body: request.body === undefined ? null : request.body.toString('utf8')
  });
}

// ─── 1. The workspace key is translated ───────────────────────────────────────

console.log('\n1. the board goes out in the peer\'s own spelling, and the local id crosses nowhere');

const byQuery = rewriteRequestForPeer({
  method: 'GET',
  path: `/api/elements?workspace=${LOCAL_ID}&kind=rectangle`,
  headers: { accept: 'application/json', 'x-client-id': CLIENT_ID, [TOKEN_HEADER]: LOCAL_TOKEN }
}, PEER);

check('a request naming a peer\'s board is rewritten', byQuery?.ok === true,
      JSON.stringify(byQuery));
if (!byQuery?.ok) { console.error('\nnothing was rewritten; the rest cannot be asserted'); process.exit(1); }

check('it says which machine it is for', byQuery.peerId === PEER_ID, JSON.stringify(byQuery.peerId));
check('and which board on it', byQuery.workspaceId === PEER_WORKSPACE,
      JSON.stringify(byQuery.workspaceId));
check('the peer\'s own reader reads the outbound as that board',
      asThePeerReadsIt(byQuery.request) === PEER_WORKSPACE,
      `${JSON.stringify(asThePeerReadsIt(byQuery.request))} — a wrong spelling does not error, `
      + `it answers from ${JSON.stringify(COLLAPSE_TARGET)}`);
check('and not from the shared board a rewritten spelling would land on',
      asThePeerReadsIt(byQuery.request) !== COLLAPSE_TARGET);
check('the local namespaced id appears nowhere in the outbound request',
      !render(byQuery.request).includes(LOCAL_ID), render(byQuery.request));
check('the path is the path that was asked for', byQuery.request.path.startsWith('/api/elements?'),
      byQuery.request.path);
check('and the request\'s own query survives beside the board name',
      byQuery.request.path.includes('kind=rectangle'), byQuery.request.path);
check('the method crosses', byQuery.request.method === 'GET', byQuery.request.method);
check('and the board is named in a spelling the reader really consults',
      Object.keys(queryRecordOf(byQuery.request.path.slice(byQuery.request.path.indexOf('?') + 1)))
        .some((key) => WORKSPACE_QUERY_KEYS.includes(key)),
      `${byQuery.request.path} against ${JSON.stringify(WORKSPACE_QUERY_KEYS)}`);
check('and it is named once rather than twice',
      byQuery.request.path.split('workspace=').length === 2, byQuery.request.path);

// ─── 2. Three spellings, one outbound request ─────────────────────────────────

console.log('\n2. query, body field and x-workspace-id: the same request, three ways');

/** The same POST, named three ways. Everything else about the three is identical on purpose. */
const SAME_REQUEST = [
  ['by query', {
    method: 'POST',
    path: `/api/elements/sync?workspace=${LOCAL_ID}`,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-client-id': CLIENT_ID,
      [TOKEN_HEADER]: LOCAL_TOKEN
    },
    body: { elements: [{ id: 'a' }] }
  }],
  ['by body field', {
    method: 'POST',
    path: '/api/elements/sync',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-client-id': CLIENT_ID,
      [TOKEN_HEADER]: LOCAL_TOKEN
    },
    body: { workspace: LOCAL_ID, elements: [{ id: 'a' }] }
  }],
  ['by x-workspace-id', {
    method: 'POST',
    path: '/api/elements/sync',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-client-id': CLIENT_ID,
      'x-workspace-id': LOCAL_ID,
      [TOKEN_HEADER]: LOCAL_TOKEN
    },
    body: { elements: [{ id: 'a' }] }
  }]
];

const rewritten = [];
for (const [how, inbound] of SAME_REQUEST) {
  // The premise: this really is a request the server reads as naming that board. A row that
  // fails here is a mistake in this file rather than in the module.
  const cut = inbound.path.indexOf('?');
  const readsAs = workspaceIdFrom({
    query: queryRecordOf(cut === -1 ? '' : inbound.path.slice(cut + 1)),
    headers: inbound.headers,
    body: inbound.body
  });
  check(`the fixture spelled ${how} really names that board to workspaceIdFrom`,
        readsAs === LOCAL_ID, `${JSON.stringify(readsAs)} rather than ${JSON.stringify(LOCAL_ID)}`);

  const result = rewriteRequestForPeer(inbound, PEER);
  check(`spelled ${how}, it is rewritten`, result?.ok === true, JSON.stringify(result));
  if (result?.ok) {
    check(`  and the peer reads it as ${PEER_WORKSPACE}`,
          asThePeerReadsIt(result.request) === PEER_WORKSPACE,
          JSON.stringify(asThePeerReadsIt(result.request)));
    check('  and the local id is not in it anywhere',
          !render(result.request).includes(LOCAL_ID), render(result.request));
    rewritten.push([how, result.request]);
  }
}

const identical = rewritten.length === SAME_REQUEST.length
  && rewritten.every(([, request]) => render(request) === render(rewritten[0][1]));
check('all three produce the identical outbound request — bytes, headers and path',
      identical,
      rewritten.map(([how, request]) => `${how}: ${render(request)}`).join('\n        '));

// ─── 3. Exactly one credential ────────────────────────────────────────────────

console.log('\n3. the local token is gone from both spellings, and one credential replaces it');

const withBothSpellings = rewriteRequestForPeer({
  method: 'GET',
  path: `/api/elements?workspace=${LOCAL_ID}&${TOKEN_QUERY}=${LOCAL_TOKEN}`,
  headers: {
    accept: 'application/json',
    [TOKEN_HEADER]: LOCAL_TOKEN,
    'x-client-id': CLIENT_ID
  }
}, PEER);

check('a request carrying the local token in both spellings is still rewritten',
      withBothSpellings?.ok === true, JSON.stringify(withBothSpellings));

if (withBothSpellings?.ok) {
  const outbound = withBothSpellings.request;
  const rendered = render(outbound);
  const cut = outbound.path.indexOf('?');
  const query = queryRecordOf(cut === -1 ? '' : outbound.path.slice(cut + 1));

  check('this board\'s token is gone from the header spelling',
        outbound.headers[TOKEN_HEADER] !== LOCAL_TOKEN, rendered);
  check('and from the query spelling', query[TOKEN_QUERY] === undefined, outbound.path);
  check('and from the request altogether — it is nowhere in it',
        !rendered.includes(LOCAL_TOKEN), rendered);

  // The failing case a draft that appends rather than replaces goes red on: two credentials
  // leave the peer to pick, and which it picks is `offeredToken`'s ordering.
  const places = [
    ['the token header', outbound.headers[TOKEN_HEADER] !== undefined],
    ['the token query parameter', query[TOKEN_QUERY] !== undefined],
    ['an authorization header', outbound.headers.authorization !== undefined]
  ].filter(([, present]) => present);
  check('the outbound request carries exactly one credential',
        places.length === 1, `${places.length}: ${places.map(([where]) => where).join(' and ')}`);
  check('and it is the peer\'s own, in the header spelling',
        outbound.headers[TOKEN_HEADER] === PEER_SECRET,
        JSON.stringify(outbound.headers[TOKEN_HEADER]));
}

// ─── 4. x-client-id crosses verbatim ──────────────────────────────────────────

console.log('\n4. x-client-id arrives byte-identical, which is what keeps #190 fixed');

check('the client id is the exact string it arrived as',
      byQuery.request.headers['x-client-id'] === CLIENT_ID,
      JSON.stringify(byQuery.request.headers['x-client-id']));

const noClientId = rewriteRequestForPeer({
  method: 'GET',
  path: `/api/elements?workspace=${LOCAL_ID}`,
  headers: { accept: 'application/json' }
}, PEER);
check('a request that carried none does not gain one this board invented',
      noClientId?.ok === true && noClientId.request.headers['x-client-id'] === undefined,
      JSON.stringify(noClientId));

// ─── 5. Hop-by-hop headers, and everything else this machine's ────────────────

console.log('\n5. what belongs to this hop stops at this hop');

const everythingElse = rewriteRequestForPeer({
  method: 'POST',
  path: `/api/elements?workspace=${LOCAL_ID}`,
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-client-id': CLIENT_ID,
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    'proxy-authenticate': 'Basic',
    'proxy-authorization': 'Basic bG9jYWw6dG9rZW4=',
    te: 'trailers',
    trailer: 'Expires',
    'transfer-encoding': 'chunked',
    upgrade: 'websocket',
    host: 'localhost:3737',
    cookie: 'session=1',
    authorization: 'Bearer something',
    'content-length': '17',
    referer: 'http://localhost:3737/',
    'user-agent': 'a browser on this machine'
  },
  body: { elements: [] }
}, PEER);

check('a request carrying every hop-by-hop header is still rewritten',
      everythingElse?.ok === true, JSON.stringify(everythingElse));

if (everythingElse?.ok) {
  const sent = Object.keys(everythingElse.request.headers);
  const crossed = (HOP_BY_HOP_HEADERS ?? []).filter((name) => sent.includes(name));
  check('no hop-by-hop header crosses', crossed.length === 0, crossed.join(', '));
  for (const name of ['host', 'cookie', 'authorization', 'referer', 'user-agent', 'content-length']) {
    check(`  ${name} stops here too`, !sent.includes(name), sent.join(', '));
  }
  check('what does cross is the request\'s own meaning and nothing else',
        sent.every((name) => ['accept', 'content-type', 'x-client-id', TOKEN_HEADER].includes(name)),
        sent.join(', '));
}

// ─── 6. The paths that describe this machine ──────────────────────────────────

console.log('\n6. a request that belongs to this machine is refused, and the refusal names which');

/**
 * Each of them, and what forwarding it would do. Named one at a time rather than sampled,
 * because a rewriter that will rewrite anything handed to it is one bug away from each.
 */
const STAYS_HERE = [
  ['POST', '/api/restart'],
  ['GET', '/api/fs/directories'],
  ['GET', '/health'],
  ['GET', '/api/agent-limits'],
  ['POST', '/api/files'],
  ['GET', '/api/files/9f8e7d'],
  ['POST', '/api/export/image/result'],
  ['POST', '/api/viewport/result']
];

for (const [method, path] of STAYS_HERE) {
  // Named by a peer's board on purpose: the refusal has to be about the path, so a request
  // that would otherwise have been rewritten is the one worth refusing.
  const result = rewriteRequestForPeer({
    method,
    path: `${path}?workspace=${LOCAL_ID}`,
    headers: { accept: 'application/json' }
  }, PEER);
  check(`${method} ${path} is refused rather than rewritten`, result?.ok === false,
        JSON.stringify(result));
  check('  and the refusal names the path it is about',
        result?.ok === false && typeof result.refusal === 'string' && result.refusal.includes(path),
        JSON.stringify(result?.refusal));
  check('  with nothing to reach for instead', result?.request === undefined, JSON.stringify(result));
  check('  and pathStaysHere says so on its own',
        typeof pathStaysHere === 'function' && pathStaysHere(path) !== null,
        JSON.stringify(typeof pathStaysHere === 'function' ? pathStaysHere(path) : 'not exported'));
}

// The router folds case and a trailing slash, so a gate that does not is a gate with a second
// spelling that walks past it — #513, one layer along.
for (const spelling of ['/API/RESTART', '/api/restart/', '/Api/Fs/Directories', '/HEALTH']) {
  const result = rewriteRequestForPeer({
    method: 'POST',
    path: `${spelling}?workspace=${LOCAL_ID}`,
    headers: {}
  }, PEER);
  check(`${spelling} is refused too — the router reads it as the same route`,
        result?.ok === false, JSON.stringify(result));
}

check('the list is stated in the module, with a reason beside each',
      Array.isArray(PATHS_THAT_STAY_HERE)
        && PATHS_THAT_STAY_HERE.length >= STAYS_HERE.length
        && PATHS_THAT_STAY_HERE.every((entry) => typeof entry?.path === 'string'
          && typeof entry?.why === 'string' && entry.why.length > 20),
      JSON.stringify(PATHS_THAT_STAY_HERE));

// A path that only looks like one of them. `/api/filestore` is not below `/api/files`.
const neighbour = rewriteRequestForPeer({
  method: 'GET',
  path: `/api/elements?workspace=${LOCAL_ID}`,
  headers: {}
}, PEER);
check('an ordinary board request is not caught by the list', neighbour?.ok === true,
      JSON.stringify(neighbour));
check('and a path that merely starts like one of them is not either',
      pathStaysHere('/api/filestore') === null, JSON.stringify(pathStaysHere('/api/filestore')));

// ─── 7. What is not a peer's board at all ─────────────────────────────────────

console.log('\n7. one of this board\'s own projects is refused, not sent somewhere');

for (const [what, spelling] of [
  ['a local project', 'field-notes'],
  ['the shared board', COLLAPSE_TARGET],
  ['a near miss of the namespace', 'peer.99.mac.field-notes']
]) {
  const result = rewriteRequestForPeer({
    method: 'GET',
    path: `/api/elements?workspace=${spelling}`,
    headers: {}
  }, PEER);
  check(`${what} is refused`, result?.ok === false, JSON.stringify(result));
  check('  and it says nothing crossed', result?.request === undefined, JSON.stringify(result));
  check('  and remoteBoardOf agrees it names no peer',
        remoteBoardOf({ path: `/api/elements?workspace=${spelling}`, headers: {} }) === null,
        JSON.stringify(remoteBoardOf({ path: `/api/elements?workspace=${spelling}`, headers: {} })));
}

// A request naming *another* peer's board must not be sent to this one with this one's secret.
const otherPeer = mintRemoteWorkspaceId('laptop', 'notes');
check('a second peer\'s board mints', otherPeer.ok === true, JSON.stringify(otherPeer));
if (otherPeer.ok) {
  const crossed = rewriteRequestForPeer({
    method: 'GET',
    path: `/api/elements?workspace=${otherPeer.id}`,
    headers: {}
  }, PEER);
  check('a board on one peer is not rewritten for another', crossed?.ok === false,
        JSON.stringify(crossed));
  check('  and the refusal names both machines',
        crossed?.ok === false && crossed.refusal.includes('laptop') && crossed.refusal.includes(PEER_ID),
        JSON.stringify(crossed?.refusal));
}

// A path that is not a path on the peer. `//elsewhere.example/x` resolves to another authority,
// which is how a credential reaches a machine nobody approved.
for (const path of ['', 'api/elements', '//elsewhere.example/api/elements', '/\\elsewhere.example/x']) {
  const result = rewriteRequestForPeer({
    method: 'GET',
    path,
    headers: { 'x-workspace-id': LOCAL_ID }
  }, PEER);
  check(`${JSON.stringify(path)} is refused rather than sent`, result?.ok === false,
        JSON.stringify(result));
}

// ─── 8. It holds nothing and decides the same thing twice ─────────────────────

console.log('\n8. the same request twice is the same answer, and the inbound is untouched');

const inbound = {
  method: 'POST',
  path: `/api/elements/sync?workspace=${LOCAL_ID}`,
  headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID },
  body: { workspace: LOCAL_ID, elements: [{ id: 'a' }] }
};
const before = JSON.stringify(inbound);
const once = rewriteRequestForPeer(inbound, PEER);
const twice = rewriteRequestForPeer(inbound, PEER);
check('twice over one request is one answer',
      once?.ok === true && twice?.ok === true && render(once.request) === render(twice.request),
      `${render(once?.request ?? {})} | ${render(twice?.request ?? {})}`);
check('and the request it was handed is unchanged', JSON.stringify(inbound) === before,
      JSON.stringify(inbound));
check('the board name was taken out of the body rather than left in it',
      once?.ok === true && !JSON.parse(once.request.body.toString('utf8')).workspace,
      once?.ok ? once.request.body.toString('utf8') : '');
check('and the peer\'s normaliser accepts the spelling it was given',
      once?.ok === true && normalizeWorkspaceId(once.workspaceId) === once.workspaceId,
      JSON.stringify(once?.workspaceId));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
