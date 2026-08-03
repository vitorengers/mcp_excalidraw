#!/usr/bin/env node
/**
 * Checks that a peer board gets four answers rather than two, and that the two refusals are
 * told apart.
 *
 * The transport already had the right discipline: `core/restart-supervisor.ts` opens a raw
 * socket with a 250 ms budget, because the case this milestone cares about is a machine that
 * is **asleep** — one that does not refuse a connection, it hangs. What it did not have was
 * anywhere to put the difference: connect and no-connect is one bit, and the states an
 * operator agreed to are four — `checking`, `online`, `unreachable`, `refused`.
 *
 * And there is a trap the transport cannot see at all. The origin gate is the **first**
 * middleware and runs on every path, `/health` included, and it pins `Host` to the authority
 * set this board answers for. A probe arriving under the peer's LAN or tailnet name is not in
 * that set and meets a **403 that has nothing whatever to do with credentials**. A probe that
 * only knows connect from timeout calls such a board `online`; one that reads every 403 as a
 * credential refusal sends the operator off to fix a credential that is fine.
 *
 * So the cases are about outcomes rather than sockets:
 *
 *   - **the transport**: refused, timed out and unresolvable all mean `unreachable`, and the
 *     connect budget is named in the answer rather than in a comment;
 *   - **the name**: a 403 whose body is the origin gate's own sentence is `refused`, with a
 *     reason that says it is the name and not the credential — and it is neither `online` nor
 *     `unreachable`;
 *   - **the credential**: a 401, and a 403 that is not the origin gate's, are `refused` too,
 *     with a *different* reason, because they are different things for the operator to fix;
 *   - **`checking` is an answer**: the state a board is in before it has one, and the state it
 *     goes back to when the last one has expired — asserted by moving an injected clock rather
 *     than by sleeping;
 *   - **two probes, not one**: `/health` is answered before any credential exists, so it
 *     separates *the process is up* from *this board is allowed on it* for free, and the
 *     credential is never handed to a port until `/health` has said a board of ours holds it.
 *
 * **The real half.** Boards, not stubs, on ports the kernel just handed out. One board is
 * probed twice: as `127.0.0.1`, which it answers for, and as `0.0.0.0`, which reaches the same
 * loopback socket while naming an authority the board does not answer for — a genuine origin-
 * gate 403 rather than a simulated one, with nothing leaving the machine and no interface
 * bound. It is given a `VIBEMAXXING_ALLOWED_HOSTS` naming something else, because a list that
 * is present and does not happen to cover the prober is the configuration a real operator has.
 * A second board keeps its token, so a probe holding none is refused a credential. A third
 * port has nothing on it at all.
 *
 * The real half cannot produce a connect *timeout* — that needs a machine that is asleep or a
 * firewall that drops rather than refuses — so that one outcome is asserted through the
 * injected connector only, and the budget it is asserted against is the constant the default
 * connector uses.
 *
 * Self-contained: its own canvas servers on ports the kernel just handed out, all killed at the
 * end. No browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-liveness-states.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

/** The four answers, and nothing else may appear in a `state`. */
const STATES = ['checking', 'online', 'unreachable', 'refused'];

/** What a board of ours puts in `/health`, spelled here rather than imported (see below). */
const HEALTHY = JSON.stringify({
  status: 'healthy', service: 'mcp-excalidraw-canvas', pid: 4242, version: '0.1.0'
});

/** The origin gate's own sentence, as `src/core/origin-gate.ts` writes it for a refused Host. */
const ORIGIN_GATE_SAID = 'This board answers for 127.0.0.1:3737, localhost:3737, and the request '
  + 'named mac.tailnet.ts.net:3737. A name that resolves here but is not this board is how DNS '
  + 'rebinding reaches a local server; if this is a real alias or a proxy, add it to '
  + 'EXCALIDRAW_ALLOWED_HOSTS.';

/** What the token gate says to a caller holding nothing. */
const TOKEN_GATE_SAID = 'This board requires its token. The launcher puts it in the URL it opens; '
  + 'a program reads it from /home/me/.local/state/server-3737.token and sends it as the '
  + 'x-vibemaxxing-token header or as ?token=. See docs/SECURITY.md.';

/** What a board says to a device whose credential it no longer honours. */
const DEVICE_SAID = 'A paired device may sign itself out, and only itself.';

const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const raw = (status, body) => ({ status, text: async () => body });

/** A fetch that never happened, for the cases where the transport answered first. */
function recordingFetch(answers) {
  const asked = [];
  const call = async (url) => {
    asked.push(String(url));
    const path = new URL(String(url)).pathname;
    const answer = answers[path];
    if (!answer) throw new Error(`the module asked for ${path}, which this case did not stub`);
    return typeof answer === 'function' ? answer() : answer;
  };
  call.asked = asked;
  return call;
}

const connectorSaying = (outcome) => {
  const call = async (target) => { call.asked.push(target); return outcome; };
  call.asked = [];
  return call;
};

const timesOut = () => {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  throw error;
};

const running = [];

async function startBoard(port, env = {}) {
  const server = startCanvas({ port, env: { LOG_LEVEL: 'error', ...env } });
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

console.log('0. the module is pure, and its budgets are constants rather than settings');

const modulePath = join(repoRoot, 'dist', 'core', 'peer-liveness.js');
const sourcePath = join(repoRoot, 'src', 'core', 'peer-liveness.ts');

if (!existsSync(modulePath)) {
  console.error('  FAIL  dist/core/peer-liveness.js exists — run ./node_modules/.bin/tsc first');
  process.exit(1);
}

const module = await import(pathToFileURL(modulePath).href);
const {
  createPeerLiveness,
  PEER_CONNECT_BUDGET_MS,
  PEER_REQUEST_BUDGET_MS,
  PEER_ANSWER_FRESHNESS_MS
} = module;

check('core/peer-liveness exports createPeerLiveness', typeof createPeerLiveness === 'function',
      `got ${typeof createPeerLiveness}`);
check('the connect budget is a named constant', PEER_CONNECT_BUDGET_MS === 250,
      `got ${JSON.stringify(PEER_CONNECT_BUDGET_MS)}`);
check('and the request budget is a second one, larger',
      typeof PEER_REQUEST_BUDGET_MS === 'number' && PEER_REQUEST_BUDGET_MS > PEER_CONNECT_BUDGET_MS,
      `got ${JSON.stringify(PEER_REQUEST_BUDGET_MS)}`);
check('an answer expires, and that budget is named too',
      typeof PEER_ANSWER_FRESHNESS_MS === 'number' && PEER_ANSWER_FRESHNESS_MS > 0,
      `got ${JSON.stringify(PEER_ANSWER_FRESHNESS_MS)}`);

const source = readFileSync(sourcePath, 'utf8');
// The three things `scripts/check-settings-documented.mjs` would have something to say about,
// and the reason neither budget is a `VIBEMAXXING_*`: a setting would drag in the generated
// tables, the generator, and two rules that red any prose stating a count of the variable set.
check('it reads no process.env', !/process\.env/.test(source));
check('it reads no file',
      !/from '(node:)?fs/.test(source) && !/readFileSync|writeFileSync|fs\.promises/.test(source));
check('and no setting name appears in it', !/VIBEMAXXING_|settingName|settings\.js/.test(source),
      'a budget that became a variable would be a documentation table away from here');

// Nothing in `src/` passes the seams — the convention `wslUnsupportedHere` and `listRoots`
// established. A caller arrives later in this milestone; what it must not do is *supply* a
// connector, a fetch or a clock, because a board that can be told what time it is or who
// answered is a board that can be lied to about a peer.
const tracked = execFileSync('git', ['ls-files', '-z', 'src'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const supplying = tracked.filter((file) => !file.endsWith('core/peer-liveness.ts')
  && /createPeerLiveness\(\s*[^)\s]/.test(readFileSync(join(repoRoot, file), 'utf8')));
check('nothing in src/ passes the connector, the fetch or the clock', supplying.length === 0,
      `${supplying.join(', ')} — a board that can be told what time it is, or who answered, is a `
      + 'board that can be lied to about a peer');

// ─── 1. The transport ─────────────────────────────────────────

console.log('\n1. a machine that refuses, one that hangs and one that has no name are all unreachable');

const clockAt = (value) => { const at = { value }; return { at, now: () => at.value }; };

async function answerFor({ connect, fetch: fetchStub, now = () => 1_000 }, target = {}) {
  const desk = createPeerLiveness({ connect, fetch: fetchStub, now });
  return { desk, answer: await desk.check({ url: 'http://peer.example:3737', ...target }) };
}

{
  const connect = connectorSaying({ kind: 'refused' });
  const fetchStub = recordingFetch({});
  const { answer } = await answerFor({ connect, fetch: fetchStub });
  check('a refused connection is unreachable', answer.state === 'unreachable',
        JSON.stringify(answer));
  check('and nothing was asked over HTTP', fetchStub.asked.length === 0,
        JSON.stringify(fetchStub.asked));
  check('the connector was given the connect budget',
        connect.asked[0]?.timeoutMs === PEER_CONNECT_BUDGET_MS, JSON.stringify(connect.asked[0]));
  check('and it was given the peer host and port',
        connect.asked[0]?.host === 'peer.example' && connect.asked[0]?.port === 3737,
        JSON.stringify(connect.asked[0]));
  check('the reason says a refusal was what happened', /refus/i.test(answer.reason),
        JSON.stringify(answer.reason));
}

{
  const { answer } = await answerFor({
    connect: connectorSaying({ kind: 'timeout' }), fetch: recordingFetch({})
  });
  check('a connection that hangs is unreachable', answer.state === 'unreachable',
        JSON.stringify(answer));
  check('and the reason names the budget it hung past',
        answer.reason.includes(String(PEER_CONNECT_BUDGET_MS)), JSON.stringify(answer.reason));
  check('a hang and a refusal do not read the same to an operator',
        answer.reason !== (await answerFor({
          connect: connectorSaying({ kind: 'refused' }), fetch: recordingFetch({})
        })).answer.reason);
}

{
  const { answer } = await answerFor({
    connect: connectorSaying({ kind: 'error', message: 'getaddrinfo ENOTFOUND peer.example' }),
    fetch: recordingFetch({})
  });
  check('a name that does not resolve is unreachable', answer.state === 'unreachable',
        JSON.stringify(answer));
  check('and the reason carries what the socket said',
        answer.reason.includes('ENOTFOUND'), JSON.stringify(answer.reason));
}

{
  const { answer } = await answerFor({
    connect: connectorSaying({ kind: 'open' }), fetch: recordingFetch({ '/health': timesOut })
  });
  check('a connection that opens and then says nothing is unreachable',
        answer.state === 'unreachable', JSON.stringify(answer));
  check('and the reason names the request budget rather than the connect one',
        answer.reason.includes(String(PEER_REQUEST_BUDGET_MS)), JSON.stringify(answer.reason));
}

{
  const { answer } = await answerFor({
    connect: connectorSaying({ kind: 'open' }),
    fetch: recordingFetch({ '/health': raw(200, 'nginx is what is on this port') })
  });
  check('something that answers 200 and is not a board of ours is unreachable',
        answer.state === 'unreachable', JSON.stringify(answer));
}

// ─── 2. The name ──────────────────────────────────────────────

console.log('\n2. a board that refuses the name this board reached it by is not a board asleep');

const originAnswer = (await answerFor({
  connect: connectorSaying({ kind: 'open' }),
  fetch: recordingFetch({ '/health': json(403, { success: false, error: ORIGIN_GATE_SAID }) })
})).answer;

check('the origin gate\'s 403 is refused', originAnswer.state === 'refused',
      JSON.stringify(originAnswer));
check('it is not reported as online', originAnswer.state !== 'online');
check('and it is not reported as unreachable', originAnswer.state !== 'unreachable');
check('the reason says it is the name and not the credential',
      /\bname\b/i.test(originAnswer.reason) && !/credential/i.test(originAnswer.reason),
      JSON.stringify(originAnswer.reason));
check('and it shows the operator what the other board actually said',
      originAnswer.reason.includes(ORIGIN_GATE_SAID.slice(0, 60)),
      JSON.stringify(originAnswer.reason));

// ─── 3. The credential ────────────────────────────────────────

console.log('\n3. a credential refusal is refused too, and it reads differently');

const tokenAnswer = (await answerFor({
  connect: connectorSaying({ kind: 'open' }),
  fetch: recordingFetch({
    '/health': raw(200, HEALTHY),
    '/api/workspaces': json(401, { success: false, error: TOKEN_GATE_SAID })
  })
})).answer;

check('a 401 behind a healthy board is refused', tokenAnswer.state === 'refused',
      JSON.stringify(tokenAnswer));
check('and it is not unreachable', tokenAnswer.state !== 'unreachable');
check('the reason is not the origin gate\'s', tokenAnswer.reason !== originAnswer.reason,
      JSON.stringify(tokenAnswer.reason));
check('it names the credential, which is what there is to fix',
      /credential/i.test(tokenAnswer.reason), JSON.stringify(tokenAnswer.reason));
check('and it shows what the other board said', tokenAnswer.reason.includes(TOKEN_GATE_SAID.slice(0, 60)),
      JSON.stringify(tokenAnswer.reason));

const deviceAnswer = (await answerFor({
  connect: connectorSaying({ kind: 'open' }),
  fetch: recordingFetch({
    '/health': raw(200, HEALTHY),
    '/api/workspaces': json(403, { success: false, error: DEVICE_SAID })
  })
}, { token: 'a-credential-this-board-holds' })).answer;

check('a 403 that is not the origin gate\'s is refused', deviceAnswer.state === 'refused',
      JSON.stringify(deviceAnswer));
check('and it reads as a credential rather than as a name',
      /credential/i.test(deviceAnswer.reason) && !/\bDNS\b/i.test(deviceAnswer.reason),
      JSON.stringify(deviceAnswer.reason));
check('which is a different thing to fix from the origin gate\'s 403',
      deviceAnswer.reason !== originAnswer.reason);

// ─── 4. The answer ────────────────────────────────────────────

console.log('\n4. online is two answers, and the credential goes to no port until the first');

{
  const fetchStub = recordingFetch({
    '/health': raw(200, HEALTHY),
    '/api/workspaces': json(200, { success: true, workspaces: [] })
  });
  const desk = createPeerLiveness({
    connect: connectorSaying({ kind: 'open' }), fetch: fetchStub, now: () => 7_000
  });
  const answer = await desk.check({ url: 'http://peer.example:3737', token: 'secret-credential' });
  check('a board that answers both probes is online', answer.state === 'online',
        JSON.stringify(answer));
  check('the answer carries the clock it was taken at', answer.at === 7_000,
        JSON.stringify(answer.at));
  check('it asked /health first', new URL(fetchStub.asked[0]).pathname === '/health',
        JSON.stringify(fetchStub.asked));
  check('and it asked twice, not once', fetchStub.asked.length === 2,
        JSON.stringify(fetchStub.asked));
}

{
  // The credential must not be handed to whatever holds that port before `/health` has said a
  // board of ours holds it. A tailnet name can point somewhere else this week.
  const sent = [];
  const fetchStub = async (url, init) => {
    sent.push({ path: new URL(String(url)).pathname, headers: { ...(init?.headers ?? {}) } });
    return raw(200, 'not a board at all');
  };
  const desk = createPeerLiveness({
    connect: connectorSaying({ kind: 'open' }), fetch: fetchStub, now: () => 1
  });
  await desk.check({ url: 'http://peer.example:3737', token: 'secret-credential' });
  const leaked = sent.filter((request) => JSON.stringify(request.headers).includes('secret-credential'));
  check('nothing on a port that is not a board of ours is given the credential',
        leaked.length === 0, JSON.stringify(sent));
}

// ─── 5. Checking ──────────────────────────────────────────────

console.log('\n5. checking is a state this module reports, and an answer expires into it');

{
  const clock = clockAt(1_000);
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const desk = createPeerLiveness({
    connect: connectorSaying({ kind: 'open' }),
    fetch: recordingFetch({
      '/health': async () => { await held; return raw(200, HEALTHY); },
      '/api/workspaces': json(200, { success: true })
    }),
    now: clock.now
  });

  const before = desk.state('http://peer.example:3737');
  check('a peer nothing has asked about yet is checking', before.state === 'checking',
        JSON.stringify(before));
  check('and it has a reason a tooltip can show', typeof before.reason === 'string' && before.reason.length > 0,
        JSON.stringify(before));

  const inFlight = desk.check({ url: 'http://peer.example:3737' });
  const during = desk.state('http://peer.example:3737');
  check('a probe under way reads as checking rather than as an absence',
        during.state === 'checking', JSON.stringify(during));
  release();
  const answer = await inFlight;
  check('and it lands on the answer it was checking for', answer.state === 'online',
        JSON.stringify(answer));

  const settled = desk.state('http://peer.example:3737');
  check('which is then what the state reads', settled.state === 'online', JSON.stringify(settled));

  clock.at.value = 1_000 + PEER_ANSWER_FRESHNESS_MS - 1;
  check('an answer inside its freshness is still the answer',
        desk.state('http://peer.example:3737').state === 'online',
        JSON.stringify(desk.state('http://peer.example:3737')));

  clock.at.value = 1_000 + PEER_ANSWER_FRESHNESS_MS + 1;
  const expired = desk.state('http://peer.example:3737');
  check('and once it has expired the board is checking again, not online',
        expired.state === 'checking', JSON.stringify(expired));
  check('every state this module produced is one of the four',
        [before, during, settled, expired, answer].every((entry) => STATES.includes(entry.state)),
        JSON.stringify([before, during, settled, expired, answer].map((entry) => entry.state)));
}

// ─── 6. Three real boards, and a port with nothing on it ──────

console.log('\n6. real boards, and no seams passed at all');

try {
  const [openPort, authedPort, deadPort] = await freePorts(3);

  const open = await startBoard(openPort, {
    // A list that is present and simply does not cover the prober — which is the configuration
    // an operator who has added one alias actually has.
    VIBEMAXXING_ALLOWED_HOSTS: 'board.example:4444'
  });
  // Its own token, so a probe holding none is refused a credential rather than served.
  const authed = await startBoard(authedPort, { EXCALIDRAW_NO_AUTH: undefined });

  // No deps at all: the connector, the fetch and the clock are the module's own defaults, which
  // is the whole of what "defaulted arguments nothing in src/ passes" has to mean.
  const desk = createPeerLiveness();

  const alive = await desk.check({ url: `http://127.0.0.1:${openPort}` });
  check('a board that is there, under a name it answers for, is online', alive.state === 'online',
        `${JSON.stringify(alive)}\n${open.read().slice(-400)}`);

  // The same socket, named as an authority this board does not answer for. Nothing leaves the
  // machine: `0.0.0.0` reaches the loopback listener, and the `Host` header carries the name.
  const refusedName = await desk.check({ url: `http://0.0.0.0:${openPort}` });
  check('the same board, reached under a name it does not answer for, is refused',
        refusedName.state === 'refused', JSON.stringify(refusedName));
  check('and it is not reported as asleep', refusedName.state !== 'unreachable',
        JSON.stringify(refusedName));
  check('the reason is the board\'s own sentence about the name',
        refusedName.reason.includes('This board answers for'), JSON.stringify(refusedName.reason));
  check('and it does not send the operator after a credential',
        !/credential/i.test(refusedName.reason), JSON.stringify(refusedName.reason));

  const refusedCredential = await desk.check({ url: `http://127.0.0.1:${authedPort}` });
  check('a board that keeps its token refuses a probe that holds none',
        refusedCredential.state === 'refused', JSON.stringify(refusedCredential));
  check('and that is not asleep either', refusedCredential.state !== 'unreachable',
        JSON.stringify(refusedCredential));
  check('the reason names the credential, and it is not the name refusal',
        /credential/i.test(refusedCredential.reason)
          && refusedCredential.reason !== refusedName.reason,
        JSON.stringify(refusedCredential.reason));

  const nothing = await desk.check({ url: `http://127.0.0.1:${deadPort}` });
  check('a port with nothing on it is unreachable', nothing.state === 'unreachable',
        JSON.stringify(nothing));

  const nowhere = await desk.check({ url: 'http://peer.invalid:3737' });
  check('and so is a machine whose name goes nowhere', nowhere.state === 'unreachable',
        JSON.stringify(nowhere));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(200);
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(300);
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
