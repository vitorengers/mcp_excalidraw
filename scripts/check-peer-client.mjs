#!/usr/bin/env node
/**
 * Checks the one thing that performs a call to a peer board: what it puts on the wire, and what
 * each way it fails comes back as.
 *
 * Two halves, because the two questions are not answerable by the same instrument.
 *
 * **A recording `http.createServer`**, which is how the header discipline is asserted — by
 * reading the bytes that arrived rather than the object that was built. The discipline is three
 * rules and each is a different failure:
 *
 *   - the **local board's token is removed in both spellings**, the `x-vibemaxxing-token` header
 *     and the `token` query parameter, because that secret is *this* server's and the peer's is a
 *     different one entirely — forwarding it is handing one board's credential to another;
 *   - the **device credential replaces it, in exactly one place**, so the peer is never presented
 *     with two and left to pick;
 *   - and **`x-client-id` crosses verbatim**, because `broadcast`'s third argument excludes the
 *     socket whose id matches, so an id substituted on the way through gets the reader its own
 *     writes echoed back a debounce later — the defect #190 was filed for.
 *
 * **Real boards**, on ports the kernel just handed out, for the answers a stub can only imitate.
 * One board keeps its token (`EXCALIDRAW_NO_AUTH: undefined`), so a call carrying the credential
 * it wrote is served and a call carrying anything else is refused for real; the same loopback
 * socket named as `0.0.0.0` produces a genuine origin-gate 403, which is the refusal that looks
 * like a credential failure and is not.
 *
 * **The two budgets are the other half of the point.** A connect budget is what turns a sleeping
 * machine into an answer — it does not refuse a connection, it hangs — and a real request is not
 * a connect probe, so the budget it runs under is stated separately. A connect *timeout* needs a
 * machine that is asleep or a firewall that drops, which nothing here can produce, so that one
 * outcome is asserted through an injected transport; a **read** timeout is produced for real, by
 * a listener that accepts and then never answers.
 *
 * Red first, against the two drafts the issue names:
 *
 *   - a draft that appends the device credential **without removing the local token**: the
 *     recording stub shows two credentials on the wire, and the peer would accept the wrong one
 *     or refuse both;
 *   - a draft **reusing one budget for connect and read**: the accept-and-never-answer listener
 *     produces the same outcome as a machine that never accepted, and the two states the operator
 *     is meant to tell apart become indistinguishable.
 *
 * Self-contained: its own listeners and its own canvas server, on ports the kernel just handed
 * out, all killed at the end. No browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-peer-client.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort, freePorts } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The four answers `core/peer-liveness.ts` gives, and there is no fifth. */
const STATES = ['checking', 'online', 'unreachable', 'refused'];

/** What a caller on this machine holds, and what must not reach another machine. */
const LOCAL_BOARD_TOKEN = 'local-board-token-0123456789abcdef';

/** What the peer approved this board under. The only credential allowed on the wire. */
const PEER_SECRET = 'peercredential.0123456789abcdef0123456789abcdef';

/** The origin gate's own sentence, as `src/core/origin-gate.ts` writes it for a refused Host. */
const ORIGIN_GATE_SAID = 'This board answers for 127.0.0.1:3737, localhost:3737, and the request '
  + 'named mac.tailnet.ts.net:3737. A name that resolves here but is not this board is how DNS '
  + 'rebinding reaches a local server; if this is a real alias or a proxy, add it to '
  + 'EXCALIDRAW_ALLOWED_HOSTS.';

/** What a board says to a device whose credential it no longer honours. */
const DEVICE_SAID = 'A paired device may sign itself out, and only itself.';

const workDir = mkdtempSync(join(tmpdir(), 'check-peer-client-'));
/** The home the board is told it has, so its token lands here and not in the real state dir. */
const fakeHome = join(workDir, 'home');
mkdirSync(fakeHome, { recursive: true });

const listeners = [];
const boards = [];

/**
 * A listener that writes down exactly what arrived and answers what the case wants.
 *
 * The **raw head** is kept as well as the parsed headers: "the local token appears in no
 * outgoing request" is a claim about bytes, and a parser that lower-cased or dropped a repeated
 * header would be answering a different question.
 */
async function recorder(answer) {
  const port = await freePort();
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const head = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
        + req.rawHeaders.map((value, index) => (index % 2 ? `${value}\r\n` : `${value}: `)).join('');
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        head,
        body: Buffer.concat(chunks),
      });
      answer(res, req);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  listeners.push(server);
  return { base: `http://127.0.0.1:${port}`, seen, port };
}

/** A listener that accepts a connection and never says anything back. */
async function silentListener() {
  const port = await freePort();
  const held = [];
  const server = createServer(() => { /* the whole point: no response, ever */ });
  server.on('connection', (socket) => held.push(socket));
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  listeners.push(server);
  return { base: `http://127.0.0.1:${port}`, close: () => held.forEach((socket) => socket.destroy()) };
}

const sendJson = (status, body) => (res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function startBoard(port, env = {}) {
  const server = startCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, `board-${port}.log`),
      // Every spelling of "where this user keeps things", so the token file lands inside the
      // temporary directory rather than in the operator's real state directory.
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: fakeHome,
      XDG_STATE_HOME: fakeHome,
      ...env,
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

/**
 * Where the token has to appear, spelled out from the platform rather than asked of the code
 * under test — the three answers `stateDir()` gives, with the leaf the tool writes today.
 */
function conventionalTokenFile(port) {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const home = process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Application Support')
    : fakeHome;
  return join(home, leaf, `server-${port}.token`);
}

/** Everything the module handed back, for the one assertion that reads all of it at the end. */
const everyResult = [];
async function call(peer, request, deps) {
  const result = await callPeer(peer, request, deps);
  everyResult.push(result);
  return result;
}

// ─── 0. The module, and what it is allowed to know ────────────

console.log('0. the module has two budgets of its own, and no way to be told anything else');

const modulePath = join(repoRoot, 'dist', 'core', 'peer-client.js');
const sourcePath = join(repoRoot, 'src', 'core', 'peer-client.ts');

if (!existsSync(modulePath)) {
  console.error('  FAIL  dist/core/peer-client.js exists — run ./node_modules/.bin/tsc first');
  process.exit(1);
}

const module = await import(pathToFileURL(modulePath).href);
const {
  callPeer,
  PEER_CALL_CONNECT_BUDGET_MS,
  PEER_CALL_BUDGET_MS,
  PEER_CALL_LIVENESS,
  PEER_HEADERS_THAT_CROSS,
} = module;

check('core/peer-client exports callPeer', typeof callPeer === 'function', `got ${typeof callPeer}`);
check('the connect budget is a named constant, and it is the one a sleeping machine needs',
      PEER_CALL_CONNECT_BUDGET_MS === 250, `got ${JSON.stringify(PEER_CALL_CONNECT_BUDGET_MS)}`);
check('the request budget is a second constant, and a longer one',
      typeof PEER_CALL_BUDGET_MS === 'number' && PEER_CALL_BUDGET_MS > PEER_CALL_CONNECT_BUDGET_MS,
      `got ${JSON.stringify(PEER_CALL_BUDGET_MS)}`);

const source = readFileSync(sourcePath, 'utf8');
// The same three reads `check-liveness-states.mjs` makes of its module, and for the same reason:
// a budget that became a `VIBEMAXXING_*` would drag in the generated tables in `docs/running.md`,
// the generator that writes them, and two rules that red any prose stating a count of the set.
check('it reads no process.env', !/process\.env\s*[.[]/.test(source));
check('it reads no file',
      !/from '(node:)?fs/.test(source) && !/readFileSync|writeFileSync|fs\.promises/.test(source));
check('and no setting name appears in it', !/settingName|settings\.js/.test(source),
      'a budget that became a variable would be a documentation table away from here');
check('it does not import the peer registry, so position 8 and this one are independent',
      !/from '\.\/peer-registry\.js'/.test(source),
      'the peer descriptor is a plain argument; a registry import would couple the two');
check('and it logs nothing, because the only interesting value it holds is a secret',
      !/logger|console\./.test(source));

// The four answers come from `core/peer-liveness.ts` rather than from a second copy here, and
// so does the one piece of classification worth copying by accident: which of the two refusals
// a 403 is. That is decided by the origin gate's own prose, and a second list of those markers
// is a list that drifts.
const tracked = execFileSync('git', ['ls-files', '-z', 'src'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean);
//
// Case-sensitive, and that is the whole trick: `core/origin-gate.ts` writes the sentence and
// spells it *DNS rebinding*, while a matcher against it is lower-cased because the comparison
// is. So the lower-cased spelling is the copy, and there may be exactly one of it.
const marking = tracked.filter((file) => {
  const text = readFileSync(join(repoRoot, file), 'utf8');
  return text.includes('dns rebinding') || text.includes('ORIGIN_GATE_MARKERS');
});
check('the origin gate\'s markers are in exactly one module, and it is the liveness one',
      marking.length === 1 && marking[0].endsWith('core/peer-liveness.ts'), marking.join(', '));
check('and this module reads them from there',
      /from '\.\/peer-liveness\.js'/.test(source), 'a second copy of the mapping is a copy that drifts');

const kinds = Object.keys(PEER_CALL_LIVENESS ?? {});
check('every outcome this module can produce names one liveness state',
      kinds.length > 0 && kinds.every((kind) => STATES.includes(PEER_CALL_LIVENESS[kind])),
      JSON.stringify(PEER_CALL_LIVENESS));
check('and no outcome maps to two of them',
      kinds.every((kind) => typeof PEER_CALL_LIVENESS[kind] === 'string'),
      JSON.stringify(PEER_CALL_LIVENESS));

// What is banned is a *transport*, not a third argument: `callPeer(peer, call)` with two object
// literals in it already carries three commas, so counting them called `core/peer-workspaces.ts`
// a breach for having named the fields of a request. A caller that names the seam is what this is
// about, and a caller that does not cannot supply one whatever its formatting.
//
// Comments blanked first, and for the reason `check-tiers.mjs` blanks them: a module explaining
// in prose which transport it defaults to is a module doing the right thing, and a rule that read
// the explanation as the breach would make writing it down the thing that fails.
const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const supplying = tracked.filter((file) => {
  if (file.endsWith('core/peer-client.ts')) return false;
  const text = withoutComments(readFileSync(join(repoRoot, file), 'utf8'));
  return /callPeer\(/.test(text) && /(transport\s*:|PeerTransport\b)/.test(text);
});
check('nothing in src/ passes the transport', supplying.length === 0,
      `${supplying.join(', ')} — a board that can be told who answered is a board that can be `
      + 'lied to about a peer');

// ─── 1. What goes on the wire ─────────────────────────────────

console.log('\n1. one credential crosses, and it is not this board\'s');

{
  const peer = await recorder(sendJson(200, { success: true, workspaces: [] }));
  const answer = await call(
    { baseUrl: peer.base, secret: PEER_SECRET },
    {
      method: 'POST',
      path: `/api/elements?workspace=a-peers-project&${'token'}=${LOCAL_BOARD_TOKEN}&pretty=1`,
      headers: {
        'x-vibemaxxing-token': LOCAL_BOARD_TOKEN,
        'x-client-id': 'tab-7f3c-9a11',
        'content-type': 'application/json',
        cookie: `session=${LOCAL_BOARD_TOKEN}`,
        host: 'this-board.local:3737',
      },
      body: Buffer.from(JSON.stringify({ type: 'text', text: 'hello' })),
    },
  );

  check('the call was answered', answer.ok === true, JSON.stringify(answer));
  const sent = peer.seen[0];
  check('exactly one request arrived', peer.seen.length === 1, `${peer.seen.length}`);

  const head = sent?.head ?? '';
  check('this board\'s token appears nowhere in the request, in any spelling',
        !head.includes(LOCAL_BOARD_TOKEN), head);
  check('and not in the request line either — the query spelling is a credential too',
        !String(sent?.url).includes('token=') || !String(sent?.url).includes(LOCAL_BOARD_TOKEN),
        String(sent?.url));
  check('the `token` query parameter is gone from the path',
        !new URL(String(sent?.url), 'http://peer.invalid').searchParams.has('token'),
        String(sent?.url));
  check('and every other query parameter survives it',
        new URL(String(sent?.url), 'http://peer.invalid').searchParams.get('workspace') === 'a-peers-project'
        && new URL(String(sent?.url), 'http://peer.invalid').searchParams.get('pretty') === '1',
        String(sent?.url));

  const credentials = (sent?.rawHeaders ?? [])
    .filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-vibemaxxing-token');
  check('the credential header appears exactly once', credentials.length === 1,
        JSON.stringify(sent?.rawHeaders));
  check('and it is the one the peer approved this board under',
        sent?.headers['x-vibemaxxing-token'] === PEER_SECRET,
        JSON.stringify(sent?.headers['x-vibemaxxing-token']));

  check('x-client-id crosses byte-identical', sent?.headers['x-client-id'] === 'tab-7f3c-9a11',
        JSON.stringify(sent?.headers['x-client-id']));
  check('the method crosses', sent?.method === 'POST', String(sent?.method));
  check('the body crosses unchanged',
        sent?.body.toString() === JSON.stringify({ type: 'text', text: 'hello' }),
        String(sent?.body));
  check('the peer is asked under its own name, not this board\'s',
        sent?.headers.host === new URL(peer.base).host, String(sent?.headers.host));
  check('and a cookie from this board\'s page does not cross', sent?.headers.cookie === undefined,
        String(sent?.headers.cookie));
}

{
  const peer = await recorder(sendJson(200, { success: true }));
  await call({ baseUrl: peer.base, secret: PEER_SECRET }, { path: '/api/workspaces' });
  check('x-client-id is absent when it was absent, rather than invented',
        peer.seen[0]?.headers['x-client-id'] === undefined,
        JSON.stringify(peer.seen[0]?.headers['x-client-id']));
  check('a call with no body sends none', peer.seen[0]?.body.length === 0,
        String(peer.seen[0]?.body.length));
  check('and the default method is a read', peer.seen[0]?.method === 'GET',
        String(peer.seen[0]?.method));
  check('the header set that crosses is named rather than inherited',
        Array.isArray(PEER_HEADERS_THAT_CROSS) && PEER_HEADERS_THAT_CROSS.includes('x-client-id'),
        JSON.stringify(PEER_HEADERS_THAT_CROSS));
}

// ─── 2. The answer, byte for byte ─────────────────────────────

console.log('\n2. an answer comes back as it was sent, so an image is not corrupted on the way');

/** Bytes no encoder round-trips: a PNG signature, a NUL, and a byte that is not valid UTF-8. */
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x42]);

{
  const peer = await recorder((res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'x-peer-said': 'something' });
    res.end(IMAGE);
  });
  const answer = await call({ baseUrl: peer.base, secret: PEER_SECRET }, { path: '/api/export' });
  check('the status comes back', answer.ok === true && answer.status === 200, JSON.stringify(answer.status));
  check('the body is the bytes the peer wrote, not a re-encoding of them',
        Buffer.isBuffer(answer.body) && Buffer.compare(answer.body, IMAGE) === 0,
        answer.body ? `${answer.body.length} bytes: ${answer.body.toString('hex')}` : 'no body');
  check('the headers come back with it',
        answer.headers?.['content-type'] === 'image/png' && answer.headers?.['x-peer-said'] === 'something',
        JSON.stringify(answer.headers));
  check('and an answer is `online`, because the peer served this board',
        answer.liveness === 'online', JSON.stringify(answer.liveness));
}

{
  const peer = await recorder(sendJson(404, { success: false, error: 'no such board here' }));
  const answer = await call({ baseUrl: peer.base, secret: PEER_SECRET }, { path: '/api/elements' });
  check('a 404 from the peer\'s own route is an answer rather than a failure',
        answer.ok === true && answer.status === 404, JSON.stringify(answer));
  check('and the peer is still online — it answered this board',
        answer.liveness === 'online', JSON.stringify(answer.liveness));
}

// ─── 3. Five ways to fail, five sentences ─────────────────────

console.log('\n3. a connect timeout, a read timeout, a 401 and the two 403s are five answers');

/** A transport that says one thing, for the outcome no listener on this machine can produce. */
const transportSaying = (outcome) => {
  const send = async (request) => { send.asked.push(request); return outcome; };
  send.asked = [];
  return send;
};

const outcomes = {};

{
  const transport = transportSaying({ kind: 'connect-timeout' });
  const answer = await call({ baseUrl: 'http://asleep.example:3737', secret: PEER_SECRET },
                            { path: '/api/workspaces' }, { transport });
  outcomes.connectTimeout = answer;
  check('a machine that never accepts is unreachable', answer.liveness === 'unreachable',
        JSON.stringify(answer));
  check('the reason names the connect budget it hung past',
        answer.reason.includes(String(PEER_CALL_CONNECT_BUDGET_MS)), JSON.stringify(answer.reason));
  check('and the transport was given both budgets, separately',
        transport.asked[0]?.connectBudgetMs === PEER_CALL_CONNECT_BUDGET_MS
        && transport.asked[0]?.requestBudgetMs === PEER_CALL_BUDGET_MS,
        JSON.stringify(transport.asked[0]));
}

{
  // For real: a listener that accepts the connection and then says nothing at all. A draft with
  // one budget for both phases cannot tell this from the case above.
  const silent = await silentListener();
  const started = Date.now();
  const answer = await call({ baseUrl: silent.base, secret: PEER_SECRET }, { path: '/api/workspaces' });
  outcomes.readTimeout = answer;
  silent.close();
  check('a board that accepts and then says nothing is unreachable too',
        answer.liveness === 'unreachable', JSON.stringify(answer));
  check('but it is a different outcome from a machine that never accepted',
        answer.kind !== outcomes.connectTimeout.kind,
        `${answer.kind} and ${outcomes.connectTimeout.kind} are the same outcome`);
  check('and it reads differently to the operator', answer.reason !== outcomes.connectTimeout.reason,
        JSON.stringify(answer.reason));
  check('the reason names the request budget rather than the connect one',
        answer.reason.includes(String(PEER_CALL_BUDGET_MS)), JSON.stringify(answer.reason));
  check('and it waited the request budget rather than the connect one',
        Date.now() - started > PEER_CALL_CONNECT_BUDGET_MS * 2,
        `gave up after ${Date.now() - started} ms, and the connect budget is ${PEER_CALL_CONNECT_BUDGET_MS}`);
}

{
  const peer = await recorder(sendJson(401, { success: false, error: 'This board requires its token.' }));
  const answer = await call({ baseUrl: peer.base, secret: PEER_SECRET }, { path: '/api/workspaces' });
  outcomes.unauthorized = answer;
  check('a 401 is refused rather than unreachable', answer.liveness === 'refused', JSON.stringify(answer));
  check('it is not an answer the caller could mistake for one', answer.ok === false, JSON.stringify(answer.ok));
  check('the reason names the credential, which is what there is to repair',
        /credential/i.test(answer.reason), JSON.stringify(answer.reason));
  check('and it carries the peer\'s own sentence', answer.reason.includes('This board requires its token.'),
        JSON.stringify(answer.reason));
}

{
  const peer = await recorder(sendJson(403, { success: false, error: ORIGIN_GATE_SAID }));
  const answer = await call({ baseUrl: peer.base, secret: PEER_SECRET }, { path: '/api/workspaces' });
  outcomes.refusedName = answer;
  check('the origin gate\'s 403 is refused', answer.liveness === 'refused', JSON.stringify(answer));
  check('the reason says it is the name and not the credential',
        /\bname\b/i.test(answer.reason) && !/credential/i.test(answer.reason),
        JSON.stringify(answer.reason));
  check('and it shows the operator what the other board actually said',
        answer.reason.includes(ORIGIN_GATE_SAID.slice(0, 60)), JSON.stringify(answer.reason));
}

{
  const peer = await recorder(sendJson(403, { success: false, error: DEVICE_SAID }));
  const answer = await call({ baseUrl: peer.base, secret: PEER_SECRET }, { path: '/api/workspaces' });
  outcomes.refusedCredential = answer;
  check('a 403 that is not the origin gate\'s is refused too', answer.liveness === 'refused',
        JSON.stringify(answer));
  check('and it reads as a credential rather than as a name',
        /credential/i.test(answer.reason) && !/\bDNS\b/i.test(answer.reason),
        JSON.stringify(answer.reason));
  check('which is a different repair from the origin gate\'s 403',
        answer.reason !== outcomes.refusedName.reason);
  check('and a different one from the 401 as well', answer.reason !== outcomes.unauthorized.reason,
        JSON.stringify(answer.reason));
}

{
  const five = ['connectTimeout', 'readTimeout', 'unauthorized', 'refusedName', 'refusedCredential']
    .map((name) => outcomes[name]);
  check('the five are five distinguishable outcomes',
        new Set(five.map((answer) => answer.kind)).size === 5,
        JSON.stringify(five.map((answer) => answer.kind)));
  check('carrying five distinct sentences',
        new Set(five.map((answer) => answer.reason)).size === 5,
        JSON.stringify(five.map((answer) => answer.reason)));
  check('and each is exactly one of the four liveness states, from the table',
        five.every((answer) => STATES.includes(answer.liveness)
          && answer.liveness === PEER_CALL_LIVENESS[answer.kind]),
        JSON.stringify(five.map((answer) => [answer.kind, answer.liveness])));
}

// ─── 4. A redirect is somewhere nobody approved ───────────────

console.log('\n4. a 3xx is not followed, and it is its own outcome');

{
  const elsewhere = await recorder(sendJson(200, { success: true }));
  const peer = await recorder((res) => {
    res.writeHead(302, { location: `${elsewhere.base}/api/workspaces` });
    res.end();
  });
  const answer = await call({ baseUrl: peer.base, secret: PEER_SECRET }, { path: '/api/workspaces' });
  check('a redirect is not an answer', answer.ok === false, JSON.stringify(answer));
  check('and it is not one of the refusals either — it is its own outcome',
        answer.kind === 'redirected', JSON.stringify(answer.kind));
  check('the place it pointed at was never asked anything', elsewhere.seen.length === 0,
        JSON.stringify(elsewhere.seen.map((request) => request.url)));
  check('the peer itself was asked once and no more', peer.seen.length === 1, `${peer.seen.length}`);
  check('the reason says the status and that it was not followed',
        answer.reason.includes('302') && /not followed|did not follow/i.test(answer.reason),
        JSON.stringify(answer.reason));
  check('and it maps to one of the four states like everything else',
        STATES.includes(answer.liveness) && answer.liveness === PEER_CALL_LIVENESS.redirected,
        JSON.stringify(answer.liveness));
}

// ─── 5. Nothing throws, and nothing leaks ─────────────────────

console.log('\n5. every failure is a value, and none of them carries the secret');

const deadPort = (await freePorts(2))[1];
const nasty = [
  ['an address that is not one', { baseUrl: 'not a url at all', secret: PEER_SECRET }, { path: '/api/workspaces' }],
  ['an address with a path on it', { baseUrl: 'http://peer.example:3737/board', secret: PEER_SECRET }, { path: '/api/workspaces' }],
  ['a scheme nothing can open', { baseUrl: 'file:///etc/passwd', secret: PEER_SECRET }, { path: '/api/workspaces' }],
  ['a path that is not a path', { baseUrl: 'http://127.0.0.1:1', secret: PEER_SECRET }, { path: 'api/workspaces' }],
  ['a path that would change the host', { baseUrl: `http://127.0.0.1:${deadPort}`, secret: PEER_SECRET }, { path: '//evil.example/api/workspaces' }],
  ['a port with nothing on it', { baseUrl: `http://127.0.0.1:${deadPort}`, secret: PEER_SECRET }, { path: '/api/workspaces' }],
  ['a name that goes nowhere', { baseUrl: 'http://peer.invalid:3737', secret: PEER_SECRET }, { path: '/api/workspaces' }],
];

for (const [what, peer, request] of nasty) {
  let thrown = null;
  let answer = null;
  try { answer = await call(peer, request); } catch (error) { thrown = error; }
  check(`${what} comes back as a value rather than as a throw`, thrown === null,
        thrown ? String(thrown.message) : '');
  check(`  …and it is a failure with a sentence and a state`,
        answer?.ok === false && typeof answer.reason === 'string' && answer.reason.length > 0
        && STATES.includes(answer.liveness),
        JSON.stringify(answer));
}

{
  const escaped = everyResult.filter((answer) => JSON.stringify(answer).includes(PEER_SECRET));
  check('no outcome this module produced carries the peer\'s secret', escaped.length === 0,
        `${escaped.length} of ${everyResult.length}: ${JSON.stringify(escaped[0] ?? null).slice(0, 200)}`);
  const local = everyResult.filter((answer) => JSON.stringify(answer).includes(LOCAL_BOARD_TOKEN));
  check('and none of them carries this board\'s token either', local.length === 0,
        JSON.stringify(local[0] ?? null).slice(0, 200));
}

// ─── 6. A real board, and a real refusal from it ──────────────

console.log('\n6. a board that keeps its token, asked by a board that holds a credential');

try {
  const [boardPort, emptyPort] = await freePorts(2);
  // `EXCALIDRAW_NO_AUTH: undefined` is the point of this section: `canvasEnvironment` turns the
  // token off for every check in this directory, and a call that is about presenting a credential
  // has to turn it back on.
  const board = await startBoard(boardPort, { EXCALIDRAW_NO_AUTH: undefined });

  const tokenFile = conventionalTokenFile(boardPort);
  const boardToken = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  check('the board wrote a token to present to it', boardToken.length >= 32,
        `${tokenFile}: ${boardToken.length} characters`);

  const served = await call({ baseUrl: board.base, secret: boardToken }, { path: '/api/workspaces' });
  check('a call carrying the credential that board honours is answered',
        served.ok === true && served.status === 200,
        `${JSON.stringify(served.reason ?? served.status)}\n${board.read().slice(-400)}`);
  check('and the body is that board\'s own answer, unread by this module',
        served.ok === true && JSON.parse(served.body.toString()).success === true,
        served.ok ? served.body.toString().slice(0, 200) : '');
  check('which is `online`', served.liveness === 'online', JSON.stringify(served.liveness));

  const wrong = await call({ baseUrl: board.base, secret: `${'f'.repeat(64)}.${'0'.repeat(64)}` },
                           { path: '/api/workspaces' });
  check('a call carrying a credential it does not know is refused, for real',
        wrong.ok === false && wrong.liveness === 'refused', JSON.stringify(wrong));
  check('and the outcome is the one the 401 case named',
        wrong.kind === outcomes.unauthorized.kind, JSON.stringify(wrong.kind));

  // The same loopback socket, named as an authority the board does not answer for. Nothing
  // leaves the machine: `0.0.0.0` reaches the listener, and the `Host` header carries the name.
  const named = await call({ baseUrl: `http://0.0.0.0:${boardPort}`, secret: boardToken },
                           { path: '/api/workspaces' });
  check('the same board, reached under a name it does not answer for, is refused',
        named.ok === false && named.liveness === 'refused', JSON.stringify(named));
  check('and it is told apart from the credential refusal, for real',
        named.kind === outcomes.refusedName.kind && named.kind !== wrong.kind,
        `${named.kind} — ${named.reason}`);
  check('the reason is that board\'s own sentence about the name',
        named.reason.includes('This board answers for'), JSON.stringify(named.reason));
  check('and it does not send the operator after a credential',
        !/credential/i.test(named.reason), JSON.stringify(named.reason));

  const empty = await call({ baseUrl: `http://127.0.0.1:${emptyPort}`, secret: boardToken },
                           { path: '/api/workspaces' });
  check('a port with nothing on it is unreachable', empty.liveness === 'unreachable',
        JSON.stringify(empty));
  check('and it is not the same outcome as a machine that hung',
        empty.kind !== outcomes.connectTimeout.kind, JSON.stringify(empty.kind));

  const leaked = everyResult.filter((answer) => boardToken && JSON.stringify(answer).includes(boardToken));
  check('and no outcome carries that board\'s token back to its caller', leaked.length === 0,
        JSON.stringify(leaked[0] ?? null).slice(0, 200));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(100);
  for (const server of listeners) server.close();
  for (const child of boards) if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(300);
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
