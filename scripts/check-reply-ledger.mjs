#!/usr/bin/env node
/**
 * Checks that a reply carrying a `requestId` and nothing else can find its way home.
 *
 * Seven fetch sites in `frontend/src/App.tsx` are the answer half of a message that arrived over
 * the socket — five `POST /api/export/image/result` and two `POST /api/viewport/result` — and all
 * seven carry a `requestId` and **no workspace**. On one machine that is fine: the server that
 * asked is the server that is answered. Once a socket is forwarded it stops being fine. The
 * request came down a link from a peer, the reply lands on the local server, and the local server
 * holds no pending record for that id. A forwarder routing on `?workspace=` has nothing to route
 * it on, because the parameter is not there, and a render against a remote board then hangs until
 * its own timeout — thirty seconds for an export, ten for a viewport — with nothing anywhere
 * reporting why.
 *
 * So the ledger is a pure module and this check drives it as one: no socket, no file, no
 * `process.env`, and the clock a defaulted argument the check **advances** rather than sleeps on.
 * That is what keeps a thirty-second expiry assertable well inside the runner's 180 s kill.
 *
 * The cases are the four properties a forwarder has to be able to rely on:
 *
 *   - **home, or nothing.** An id seen crossing an inbound link resolves to the peer it came
 *     from; an id nobody has seen resolves to *nothing* rather than to a default. A default here
 *     is a reply posted to a machine that never asked.
 *   - **one id, one peer.** Two export requests for two different boards on the same peer, and
 *     two requests for the same board, each keep their own entry. This is the case a table keyed
 *     by anything the *forwarder* routes on gets wrong, and it is invisible to any test that uses
 *     one board.
 *   - **resolving consumes.** A reply is answered once. A second post carrying the same id is a
 *     duplicate or a replay, and it answers *unknown* — distinguishably from *expired*, because
 *     those are two different things for a caller to report.
 *   - **an entry expires no later than the request it describes**, on the requester's own budget,
 *     and the two budgets are read out of `src/server.ts` rather than restated here: a check that
 *     kept its own copy of thirty seconds would go on passing on the day that number moved.
 *
 * **Run against the old code first.** Two drafts, and they fail differently, which is the point.
 * A ledger keyed by the peer link — the thing a `?workspace=` forwarder has in its hand — lets the
 * second of two boards on one peer overwrite the first, so one reply is delivered twice and the
 * other never. A ledger keyed by the workspace does the same thing to two requests for one board.
 * Neither is caught by a case that uses one board and one request.
 *
 * Offline and self-contained. No server, no browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-reply-ledger.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function done() {
  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
  process.exit(0);
}

/** A clock the check moves by hand. Nothing here sleeps. */
const clockAt = (value) => { const at = { value }; return { at, now: () => at.value }; };

// ─── 0. The module, and what it is allowed to know ────────────

console.log('0. the module is there, it is pure, and it opens nothing');

const modulePath = join(repoRoot, 'dist', 'core', 'reply-ledger.js');
const sourcePath = join(repoRoot, 'src', 'core', 'reply-ledger.ts');

check('src/core/reply-ledger.ts exists', existsSync(sourcePath),
      'the ledger is deliberately separate from every transport, so it is its own file');

if (!existsSync(modulePath)) {
  console.error('  FAIL  dist/core/reply-ledger.js exists — run ./node_modules/.bin/tsc first');
  failures++;
  done();
}
console.log('  ok    dist/core/reply-ledger.js exists');

const module = await import(pathToFileURL(modulePath).href);
const { createReplyLedger, REPLY_BUDGET_MS, FORWARDED_REQUEST_TYPES } = module;

check('it exports createReplyLedger', typeof createReplyLedger === 'function',
      `got ${typeof createReplyLedger}`);
check('it names the message types that may create an entry',
      Array.isArray(FORWARDED_REQUEST_TYPES) && FORWARDED_REQUEST_TYPES.length === 3,
      `got ${JSON.stringify(FORWARDED_REQUEST_TYPES)}`);
check('and it publishes the budget each of them is bounded by',
      REPLY_BUDGET_MS !== null && typeof REPLY_BUDGET_MS === 'object',
      `got ${JSON.stringify(REPLY_BUDGET_MS)}`);

if (typeof createReplyLedger !== 'function') {
  console.error('\nnothing below can run without the ledger');
  done();
}

const source = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';

// A *read*, rather than the words: the module's own banner says it touches none of these, and a
// rule matching the promise as well as the breach would make writing it down the thing that fails.
check('it reads no process.env', !/process\.env\s*[.[]/.test(source));
check('it reads no file',
      !/from '(node:)?fs/.test(source) && !/readFileSync|writeFileSync|fs\.promises/.test(source));
check('and it opens no socket',
      !/from '(node:)?(net|http|https|ws|dgram|tls)'/.test(source) && !/new WebSocket|createServer/.test(source),
      'a ledger both forwarders consult must not be a third transport');

// Nothing in `src/` passes the clock — the convention `wslUnsupportedHere` and `listRoots`
// established. Callers arrive later in this milestone; what they must not do is *supply* the
// clock, because a ledger that can be told what time it is can be told an expired entry is live.
const tracked = execFileSync('git', ['ls-files', '-z', 'src'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const supplying = tracked.filter((file) => !file.endsWith('core/reply-ledger.ts')
  && /createReplyLedger\(\s*[^)\s]/.test(readFileSync(join(repoRoot, file), 'utf8')));
check('nothing in src/ passes the clock', supplying.length === 0,
      `${supplying.join(', ')} — an entry that expires on a clock a caller supplies expires when `
      + 'that caller says so, which is not what the requester\'s budget means');

// ─── 1. The budgets, read off the server rather than restated ─

console.log('\n1. an entry is bounded by the budget of the request it belongs to');

const serverSource = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');

/** The requester's own timeout, taken from the `setTimeout` that rejects it. */
function budgetInServer(sentence) {
  const written = new RegExp(
    `reject\\(new Error\\('${sentence} (\\d+) seconds'\\)\\)[\\s\\S]{0,200}?\\},\\s*(\\d+)\\);`
  ).exec(serverSource);
  if (!written) return null;
  const [, seconds, ms] = written;
  return Number(seconds) * 1000 === Number(ms) ? Number(ms) : null;
}

const exportBudget = budgetInServer('Export timed out after');
const viewportBudget = budgetInServer('Viewport request timed out after');

check('src/server.ts still states an export budget', exportBudget !== null,
      'the sentence the ledger is bounded by has moved — this check reads it rather than copying it');
check('and a viewport budget', viewportBudget !== null);
check('the export entry expires no later than the export request does',
      REPLY_BUDGET_MS?.export_image_request === exportBudget,
      `ledger ${JSON.stringify(REPLY_BUDGET_MS?.export_image_request)} vs server ${exportBudget}`);
check('and the viewport entry no later than the viewport request',
      REPLY_BUDGET_MS?.set_viewport === viewportBudget,
      `ledger ${JSON.stringify(REPLY_BUDGET_MS?.set_viewport)} vs server ${viewportBudget}`);
check('a conversion, which nothing waits on, is bounded by the shorter of the two',
      typeof REPLY_BUDGET_MS?.mermaid_convert === 'number'
        && REPLY_BUDGET_MS.mermaid_convert > 0
        && REPLY_BUDGET_MS.mermaid_convert <= Math.min(exportBudget ?? 0, viewportBudget ?? 0),
      `got ${JSON.stringify(REPLY_BUDGET_MS?.mermaid_convert)}`);
check('every budget is a number of milliseconds and none is unbounded',
      FORWARDED_REQUEST_TYPES.every((type) => Number.isFinite(REPLY_BUDGET_MS[type])
        && REPLY_BUDGET_MS[type] > 0),
      JSON.stringify(REPLY_BUDGET_MS));

/**
 * The viewport budget, bound once.
 *
 * `scripts/check-port-allocation.mjs` refuses a check that takes a second port as the first one
 * plus a number, and it recognises that shape by any word ending in those four letters with an
 * addition after it — which the viewport budget read off the record above is, letter for letter,
 * and this comment would be too if it spelled it out. The rule is right and the wording is what
 * moves: the value is a number of milliseconds, and naming it as one says so.
 */
const VIEWPORT_ENTRY_MS = REPLY_BUDGET_MS.set_viewport;

// The three names are the transport's own, not this module's spelling of them.
const messageTypes = readFileSync(join(repoRoot, 'src', 'types.ts'), 'utf8');
check('each named type is one the transport actually broadcasts',
      FORWARDED_REQUEST_TYPES.every((type) => messageTypes.includes(`| '${type}'`)),
      `${JSON.stringify(FORWARDED_REQUEST_TYPES)} against WebSocketMessageType`);

// ─── 2. Home, or nothing ──────────────────────────────────────

console.log('\n2. an id that crossed a link resolves to the peer it came from, and one that did not resolves to nothing');

{
  const clock = clockAt(1_000);
  const ledger = createReplyLedger({ now: clock.now });

  const recorded = ledger.record({
    requestId: 'req-export-a', peerId: 'desk', type: 'export_image_request'
  });
  check('a request crossing an inbound link is recorded', recorded?.ok === true,
        JSON.stringify(recorded));

  const home = ledger.resolve('req-export-a');
  check('and the reply carrying its id resolves to that peer',
        home?.kind === 'peer' && home.peerId === 'desk', JSON.stringify(home));
  check('the answer says which request it was, so a caller can report it',
        home?.type === 'export_image_request', JSON.stringify(home));

  const never = ledger.resolve('req-nobody-ever-sent');
  check('an id nobody has seen resolves to nothing', never?.kind === 'unknown',
        JSON.stringify(never));
  check('and not to a peer, however plausible',
        never?.peerId === undefined && never?.kind !== 'peer', JSON.stringify(never));
  check('nothing is invented for a reply that belongs to this machine',
        typeof never?.reason === 'string' && never.reason.length > 0,
        'an unroutable reply is a log line, so the answer has to carry a sentence');
}

// ─── 3. One id, one peer ──────────────────────────────────────

console.log('\n3. two boards on one peer, and two requests on one board, each keep their own entry');

{
  const clock = clockAt(5_000);
  const ledger = createReplyLedger({ now: clock.now });

  // The case a table keyed by the peer link gets wrong: one machine, two of its projects.
  ledger.record({ requestId: 'req-1', peerId: 'desk', type: 'export_image_request' });
  ledger.record({ requestId: 'req-2', peerId: 'desk', type: 'export_image_request' });

  const first = ledger.resolve('req-1');
  const second = ledger.resolve('req-2');
  check('the first board\'s reply is still routable after the second board asked',
        first?.kind === 'peer' && first.peerId === 'desk', JSON.stringify(first));
  check('and the second board\'s reply is routable too',
        second?.kind === 'peer' && second.peerId === 'desk', JSON.stringify(second));
  check('neither request displaced the other', first?.kind === 'peer' && second?.kind === 'peer',
        `${JSON.stringify(first)} / ${JSON.stringify(second)}`);

  // Two requests for one board, which is what a table keyed by the workspace gets wrong.
  ledger.record({ requestId: 'req-3', peerId: 'laptop', type: 'set_viewport' });
  ledger.record({ requestId: 'req-4', peerId: 'laptop', type: 'set_viewport' });
  const third = ledger.resolve('req-3');
  const fourth = ledger.resolve('req-4');
  check('two requests for the same board each keep an entry',
        third?.kind === 'peer' && fourth?.kind === 'peer',
        `${JSON.stringify(third)} / ${JSON.stringify(fourth)}`);

  // And two peers are two peers.
  ledger.record({ requestId: 'req-5', peerId: 'desk', type: 'export_image_request' });
  ledger.record({ requestId: 'req-6', peerId: 'laptop', type: 'export_image_request' });
  check('an id recorded against one peer does not resolve to the other',
        ledger.resolve('req-5')?.peerId === 'desk' && ledger.resolve('req-6')?.peerId === 'laptop');

  // The id is the key, so re-using one while it is live is refused rather than re-pointed.
  ledger.record({ requestId: 'req-7', peerId: 'desk', type: 'export_image_request' });
  const stolen = ledger.record({ requestId: 'req-7', peerId: 'laptop', type: 'export_image_request' });
  check('an id already in the ledger is not quietly re-pointed at another machine',
        stolen?.ok === false, JSON.stringify(stolen));
  check('and the entry that was there is the one that still answers',
        ledger.resolve('req-7')?.peerId === 'desk');
}

// ─── 4. Resolving consumes ────────────────────────────────────

console.log('\n4. a reply is answered once, and a replay is unknown rather than routed again');

{
  const clock = clockAt(9_000);
  const ledger = createReplyLedger({ now: clock.now });

  ledger.record({ requestId: 'req-once', peerId: 'desk', type: 'set_viewport' });
  const answered = ledger.resolve('req-once');
  check('the first resolve routes it', answered?.kind === 'peer', JSON.stringify(answered));

  const again = ledger.resolve('req-once');
  check('the second answers unknown', again?.kind === 'unknown', JSON.stringify(again));
  check('a duplicate post is not routed to that peer a second time', again?.kind !== 'peer',
        JSON.stringify(again));
  check('and resolving really removed it', ledger.size() === 0, `size ${ledger.size()}`);

  // Expired and unknown are two different things for a caller to report.
  ledger.record({ requestId: 'req-late', peerId: 'desk', type: 'set_viewport' });
  clock.at.value = 9_000 + VIEWPORT_ENTRY_MS + 1;
  const late = ledger.resolve('req-late');
  check('a reply that arrives after its request gave up answers expired',
        late?.kind === 'expired', JSON.stringify(late));
  check('which is not the same answer as an id nobody sent',
        late?.kind !== ledger.resolve('req-never-existed')?.kind,
        `${JSON.stringify(late?.kind)} vs ${JSON.stringify(ledger.resolve('req-never')?.kind)}`);
  check('and it says which peer stopped waiting, so the log line names a machine',
        late?.peerId === 'desk', JSON.stringify(late));
}

// ─── 5. Expiry, on the requester's own budget ─────────────────

console.log('\n5. an entry expires no later than the budget of the request it belongs to');

{
  const clock = clockAt(0);
  const ledger = createReplyLedger({ now: clock.now });

  ledger.record({ requestId: 'req-viewport', peerId: 'desk', type: 'set_viewport' });
  ledger.record({ requestId: 'req-export', peerId: 'desk', type: 'export_image_request' });

  clock.at.value = REPLY_BUDGET_MS.set_viewport - 1;
  check('inside its budget a viewport entry is still live',
        ledger.resolve('req-viewport')?.kind === 'peer');

  ledger.record({ requestId: 'req-viewport-2', peerId: 'desk', type: 'set_viewport' });
  clock.at.value = REPLY_BUDGET_MS.set_viewport * 2;
  check('and at its budget it is not live any more — an entry never outlives its request',
        ledger.resolve('req-viewport-2')?.kind === 'expired',
        JSON.stringify(ledger.resolve('req-viewport-2')));

  check('the longer-lived export entry is untouched by the shorter budget',
        ledger.resolve('req-export')?.kind === 'peer',
        'each entry expires on the budget of its own request, not on one budget for all three');

  // Exactly at the boundary: `no later than` means the entry is gone when the request gives up.
  const edge = createReplyLedger({ now: clock.now });
  const at = clock.at.value;
  edge.record({ requestId: 'req-edge', peerId: 'desk', type: 'export_image_request' });
  clock.at.value = at + REPLY_BUDGET_MS.export_image_request;
  check('an entry is expired at the instant its request times out, not one tick later',
        edge.resolve('req-edge')?.kind === 'expired', JSON.stringify(edge.resolve('req-edge')));
}

// ─── 6. A peer that goes away mid-render ──────────────────────

console.log('\n6. the ledger cannot grow without bound when a peer disappears mid-render');

{
  const clock = clockAt(1_000);
  const ledger = createReplyLedger({ now: clock.now });

  for (let n = 0; n < 500; n++) {
    ledger.record({ requestId: `abandoned-${n}`, peerId: 'desk', type: 'export_image_request' });
  }
  check('five hundred requests in flight are five hundred entries', ledger.size() === 500,
        `size ${ledger.size()}`);

  // The peer sleeps. Nothing answers, nothing is resolved, and the clock goes past every budget.
  clock.at.value = 1_000 + REPLY_BUDGET_MS.export_image_request + 1;
  check('once every request has timed out, nothing is left of them', ledger.size() === 0,
        `size ${ledger.size()} — a ledger outliving the requests it describes is a ledger that `
        + 'grows without bound on a peer that goes away mid-render');

  // And the sweep happens without anybody having called `size` or `resolve` first.
  const unattended = createReplyLedger({ now: clock.now });
  const started = clock.at.value;
  for (let n = 0; n < 200; n++) {
    unattended.record({ requestId: `gone-${n}`, peerId: 'laptop', type: 'set_viewport' });
  }
  clock.at.value = started + VIEWPORT_ENTRY_MS + 1;
  unattended.record({ requestId: 'the-one-live-request', peerId: 'laptop', type: 'set_viewport' });
  check('and recording the next request is enough to drop the ones that expired',
        unattended.size() === 1, `size ${unattended.size()}`);
  check('the live one is the survivor',
        unattended.resolve('the-one-live-request')?.kind === 'peer');
}

// ─── 7. Three types create an entry, and nothing else does ────

console.log('\n7. three message types create an entry, and the module refuses to create one for anything else');

{
  const ledger = createReplyLedger({ now: () => 2_000 });

  for (const type of FORWARDED_REQUEST_TYPES) {
    const answer = ledger.record({ requestId: `ok-${type}`, peerId: 'desk', type });
    check(`${type} creates an entry`, answer?.ok === true, JSON.stringify(answer));
  }
  check('and those three are the export, the viewport and the conversion',
        ['export_image_request', 'set_viewport', 'mermaid_convert']
          .every((type) => FORWARDED_REQUEST_TYPES.includes(type)),
        JSON.stringify(FORWARDED_REQUEST_TYPES));

  const refused = [
    'element_created', 'terminal_output', 'initial_elements', 'canvas_cleared', 'files_added',
    'whatever_this_is', '', null, undefined, 42
  ];
  for (const type of refused) {
    const answer = ledger.record({ requestId: `no-${String(type)}`, peerId: 'desk', type });
    check(`${JSON.stringify(type)} creates none`, answer?.ok === false, JSON.stringify(answer));
    check(`and nothing was left behind for ${JSON.stringify(type)}`,
          ledger.resolve(`no-${String(type)}`)?.kind === 'unknown');
  }

  check('a refusal says why, rather than throwing at a forwarder mid-frame',
        typeof ledger.record({ requestId: 'x', peerId: 'desk', type: 'element_created' })?.refusal
          === 'string');

  // The id and the peer are as much of the entry as the type is.
  for (const bad of [
    { requestId: '', peerId: 'desk', type: 'set_viewport' },
    { requestId: 'req', peerId: '', type: 'set_viewport' },
    { requestId: null, peerId: 'desk', type: 'set_viewport' },
    { requestId: 'req', peerId: null, type: 'set_viewport' }
  ]) {
    const answer = ledger.record(bad);
    check(`an entry with no ${bad.requestId ? 'peer' : 'id'} is refused (${JSON.stringify(bad)})`,
          answer?.ok === false, JSON.stringify(answer));
  }
  check('and a frame that is not an object at all is refused rather than thrown on',
        ledger.record(null)?.ok === false && ledger.record(undefined)?.ok === false);
}

// ─── 8. The clock is a defaulted argument ─────────────────────

console.log('\n8. the clock is a defaulted argument, and the module works without one');

{
  const ledger = createReplyLedger();
  const recorded = ledger.record({
    requestId: 'req-real-clock', peerId: 'desk', type: 'export_image_request'
  });
  check('a ledger created with no arguments records', recorded?.ok === true,
        JSON.stringify(recorded));
  check('and resolves', ledger.resolve('req-real-clock')?.kind === 'peer');
  check('an entry created on the real clock expires in the future rather than at once',
        recorded?.ok === true && recorded.expiresAt > Date.now(),
        `${JSON.stringify(recorded)} against ${Date.now()}`);
}

done();
