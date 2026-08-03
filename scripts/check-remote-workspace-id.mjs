#!/usr/bin/env node
/**
 * Checks that a peer's project id survives the other board's own normaliser, in both
 * directions.
 *
 * `normalizeWorkspaceId` in `core/element-store.ts` does not reject: anything failing
 * `[a-z0-9]` and friends is **rewritten to the literal id `default`**, and the WebSocket
 * upgrade path applies it to `?workspace=` with no registry lookup at all. So a namespacing
 * scheme spelled `pc:board-tool` does not error — it lands that socket on the host's shared
 * `default` board and starts streaming it, and nothing logs. The page just shows the wrong
 * scene. That is the failure this module exists to make impossible, and the assertion that
 * catches it is a **composition**, not a round trip: minting and splitting can agree with each
 * other perfectly while every id they agree on collapses the moment a board reads it.
 *
 * So the cases are:
 *
 *   - **the table**: ids sweeping the characters the class admits — the separators, runs of
 *     them, a trailing one, a single character, `default` itself, and an id that is spelled
 *     like a namespaced one — each minted against several peers, each split back, and **each
 *     minted id fed through the compiled `normalizeWorkspaceId` and required to come back
 *     unchanged**. Over the whole table rather than a sample, because the defect is one row;
 *   - **the inverse is the one the wire needs**: what `split` hands back is the spelling the
 *     *peer's* own normaliser expects on the upstream URL, so it is asserted against that
 *     normaliser too. Getting this backwards is how a forwarded request reaches the right
 *     machine and the wrong board;
 *   - **it is a bijection**: no two distinct pairs may mint one id, asserted over the whole
 *     cross product, and including the pair a separator-joined scheme cannot tell apart —
 *     peer `a.b` holding `c` against peer `a` holding `b.c`;
 *   - **what the class does not admit is refused**: uppercase, a leading underscore, a leading
 *     dot, an id past 64 characters, the empty string, a colon, a slash — refused with a
 *     sentence, never collapsed to `default` and never truncated;
 *   - **the budget is named**: an id that cannot be namespaced inside 64 characters is refused
 *     by a sentence carrying that number, and the boundary — the longest pair that does fit —
 *     mints and survives the normaliser;
 *   - **two peers holding a folder of the same name** get two different local ids, constructed
 *     here rather than assumed;
 *   - **the module is pure**: no file, no socket, no `process.env`, no element store, and it
 *     imports `normalizeWorkspaceId` rather than restating that expression a second time.
 *
 * Self-contained: it drives two compiled modules and starts nothing. No server, no browser.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-remote-workspace-id.mjs
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

// ─── 0. The two modules, and what this one is allowed to know ─────────────────

console.log('0. the module is pure, and it asks the normaliser rather than restating it');

const modulePath = join(repoRoot, 'dist', 'core', 'remote-workspace-id.js');
const storePath = join(repoRoot, 'dist', 'core', 'element-store.js');
const sourcePath = join(repoRoot, 'src', 'core', 'remote-workspace-id.ts');

for (const [what, where] of [['remote-workspace-id', modulePath], ['element-store', storePath]]) {
  if (!existsSync(where)) {
    console.error(`  FAIL  dist/core/${what}.js exists — run ./node_modules/.bin/tsc first`);
    process.exit(1);
  }
}

const module = await import(pathToFileURL(modulePath).href);
const { normalizeWorkspaceId } = await import(pathToFileURL(storePath).href);
const { mintRemoteWorkspaceId, splitRemoteWorkspaceId, isRemoteWorkspaceId } = module;

check('core/remote-workspace-id exports mintRemoteWorkspaceId',
      typeof mintRemoteWorkspaceId === 'function', `got ${typeof mintRemoteWorkspaceId}`);
check('and splitRemoteWorkspaceId, the inverse the wire needs',
      typeof splitRemoteWorkspaceId === 'function', `got ${typeof splitRemoteWorkspaceId}`);
check('and isRemoteWorkspaceId, so a caller can ask before it splits',
      typeof isRemoteWorkspaceId === 'function', `got ${typeof isRemoteWorkspaceId}`);

if (typeof mintRemoteWorkspaceId !== 'function' || typeof splitRemoteWorkspaceId !== 'function') {
  console.error('\nthe module does not export the pair; nothing below can be asserted');
  process.exit(1);
}

/** So that a draft missing the third export goes red on it rather than taking the run down. */
const recognises = typeof isRemoteWorkspaceId === 'function'
  ? isRemoteWorkspaceId
  : () => 'not exported';

const source = readFileSync(sourcePath, 'utf8');

check('it imports normalizeWorkspaceId from the element store',
      /import\s*\{[^}]*normalizeWorkspaceId[^}]*\}\s*from\s*'\.\/element-store\.js'/.test(source),
      'the assertion has to be made against the expression that is really applied');
// Two copies of that character class in one tree is one copy too many, and the copy that
// drifts is the one nobody is looking at.
check('and does not restate the class it accepts', !/a-z0-9/.test(source),
      'the regex belongs in element-store.ts and nowhere else');
check('it reads no file',
      !/from '(node:)?fs'/.test(source) && !/readFileSync|writeFileSync|fs\.promises/.test(source));
check('it opens no socket',
      !/from '(node:)?(net|http|https|ws)'/.test(source) && !/createConnection|fetch\(/.test(source));
check('it reads no process.env', !/process\.env\s*[.[]/.test(source));
// `elementsFor` yields an empty store for an unknown id by design, and eleven sibling maps are
// created on first use the same way. A stray read here does not fail — it manufactures a
// plausible blank board for a project another machine owns.
check('and it touches no element store, board state or per-id map',
      !/elementsFor|activeWorkspaceIds|boardState|elementsFor\(/.test(source),
      'this module creates nothing and stores nothing');

// ─── 1. The table: every id the peer's own regex accepts ──────────────────────

console.log('\n1. every id the peer accepts round-trips, and every minted id survives its normaliser');

/**
 * Workspace ids sweeping what `[a-z0-9][a-z0-9._-]{0,63}` admits: each of the three
 * separators alone, runs of them, a trailing one, the shortest id there is, the id the
 * normaliser collapses *to* — which is a perfectly legitimate board on the other machine —
 * and one spelled like something this module itself mints.
 */
const WORKSPACE_IDS = [
  'a',
  '0',
  'z9',
  'board-tool',
  'board.tool',
  'board_tool',
  'a.b-c_d',
  'a---b',
  'a...b',
  'a___b',
  'a-',
  'a.',
  'a_',
  'a-._',
  'abcdefghijklmnopqrstuvwxyz0123456789',
  COLLAPSE_TARGET,
  'peer.02.pc.mirror',
];

/**
 * Peers, spelled with the same separators, because a peer id is an id like any other. Every
 * pair below is inside the budget on purpose — what happens at it is section 4's subject, and a
 * table that ran past it would be asserting two things at once.
 */
const PEER_IDS = ['mac', 'pc', 'a', 'a.b', 'a-b', 'a_b', COLLAPSE_TARGET, 'x'.repeat(16)];

// The check's own premise: everything in the two tables is something the other board's
// normaliser already accepts. A row that fails here is a mistake in this file.
const notReallyAccepted = [...WORKSPACE_IDS, ...PEER_IDS]
  .filter((id) => normalizeWorkspaceId(id) !== id);
check('the table is made of ids the peer\'s own normaliser accepts unchanged',
      notReallyAccepted.length === 0, notReallyAccepted.join(', '));

const minted = new Map();
const refused = [];
const notSurviving = [];
const notRoundTripping = [];
const collapsed = [];
const collisions = [];
const upstreamNotAccepted = [];
const notRecognised = [];

for (const peerId of PEER_IDS) {
  for (const workspaceId of WORKSPACE_IDS) {
    const where = `peer ${JSON.stringify(peerId)} holding ${JSON.stringify(workspaceId)}`;
    const result = mintRemoteWorkspaceId(peerId, workspaceId);
    if (!result?.ok) { refused.push(`${where} → ${JSON.stringify(result?.refusal)}`); continue; }
    const id = result.id;

    // The assertion that matters. Everything else in this file is about keeping it honest.
    if (normalizeWorkspaceId(id) !== id) {
      notSurviving.push(`${where} minted ${JSON.stringify(id)}, which the peer reads as `
        + JSON.stringify(normalizeWorkspaceId(id)));
    }
    if (id === COLLAPSE_TARGET) collapsed.push(where);
    if (recognises(id) !== true) notRecognised.push(`${where} minted ${JSON.stringify(id)}`);

    const back = splitRemoteWorkspaceId(id);
    if (back?.peerId !== peerId || back?.workspaceId !== workspaceId) {
      notRoundTripping.push(`${where} minted ${JSON.stringify(id)} and split to `
        + JSON.stringify(back));
    } else if (normalizeWorkspaceId(back.workspaceId) !== back.workspaceId) {
      // The inverse is what goes on the upstream URL. A spelling the peer's own normaliser
      // rewrites is how a forwarded request reaches the right machine and the wrong board.
      upstreamNotAccepted.push(`${where} → ${JSON.stringify(back.workspaceId)}`);
    }

    const already = minted.get(id);
    if (already) collisions.push(`${already} and ${where} both minted ${JSON.stringify(id)}`);
    else minted.set(id, where);
  }
}

const rows = PEER_IDS.length * WORKSPACE_IDS.length;
check(`all ${rows} pairs mint`, refused.length === 0, refused.slice(0, 3).join(' | '));
check('every minted id survives normalizeWorkspaceId unchanged — all of them, not a sample',
      notSurviving.length === 0,
      `${notSurviving.length} of ${rows}: ${notSurviving.slice(0, 3).join(' | ')}`);
check('no minted id is the id the normaliser collapses to', collapsed.length === 0,
      collapsed.slice(0, 3).join(' | '));
check('minting and splitting round-trip on every row', notRoundTripping.length === 0,
      `${notRoundTripping.length} of ${rows}: ${notRoundTripping.slice(0, 3).join(' | ')}`);
check('and what splitting hands back is a spelling the peer itself accepts',
      upstreamNotAccepted.length === 0, upstreamNotAccepted.slice(0, 3).join(' | '));
check('a minted id is recognised as one of ours', notRecognised.length === 0,
      notRecognised.slice(0, 3).join(' | '));
check('no two pairs mint the same id', collisions.length === 0, collisions.slice(0, 3).join(' | '));

// ─── 2. The pairs a separator alone cannot tell apart ─────────────────────────

console.log('\n2. two peers, one folder name — and the join a separator cannot invert');

const macBoard = mintRemoteWorkspaceId('mac', 'board-tool');
const pcBoard = mintRemoteWorkspaceId('pc', 'board-tool');
check('two peers each holding a folder called board-tool both mint',
      macBoard.ok && pcBoard.ok, JSON.stringify([macBoard, pcBoard]));
check('and the two local ids are different', macBoard.ok && pcBoard.ok && macBoard.id !== pcBoard.id,
      macBoard.ok && pcBoard.ok ? macBoard.id : '');
check('each splits back to its own machine',
      splitRemoteWorkspaceId(macBoard.id)?.peerId === 'mac'
        && splitRemoteWorkspaceId(pcBoard.id)?.peerId === 'pc',
      JSON.stringify([splitRemoteWorkspaceId(macBoard.id), splitRemoteWorkspaceId(pcBoard.id)]));

// The pair that decides the scheme. `peer` + separator + `workspace` cannot be inverted,
// because both halves may contain every separator the class admits: these two would be one
// string, and one of the two boards would be unreachable through it.
const dotted = mintRemoteWorkspaceId('a.b', 'c');
const otherWay = mintRemoteWorkspaceId('a', 'b.c');
check('peer a.b holding c and peer a holding b.c are two different local ids',
      dotted.ok && otherWay.ok && dotted.id !== otherWay.id,
      JSON.stringify([dotted, otherWay]));
check('and each splits back to the pair it was made from',
      JSON.stringify(splitRemoteWorkspaceId(dotted.id)) === JSON.stringify({ peerId: 'a.b', workspaceId: 'c' })
        && JSON.stringify(splitRemoteWorkspaceId(otherWay.id)) === JSON.stringify({ peerId: 'a', workspaceId: 'b.c' }),
      JSON.stringify([splitRemoteWorkspaceId(dotted.id), splitRemoteWorkspaceId(otherWay.id)]));

// ─── 3. What the class does not admit is refused, not collapsed ───────────────

console.log('\n3. an id the class does not admit is refused with a sentence');

/** One case for each way an id fails the class the peer applies. */
const NOT_ADMITTED = [
  ['uppercase', 'Board'],
  ['a leading underscore', '_board'],
  ['a leading dot', '.board'],
  ['a leading hyphen', '-board'],
  ['a leading space', ' board'],
  ['the empty string', ''],
  ['whitespace alone', '   '],
  ['a colon — the obvious first spelling', 'pc:board-tool'],
  ['a slash', 'pc/board-tool'],
  ['an inner space', 'board tool'],
  ['a character outside the class', 'boarð'],
  ['a name past 64 characters', 'a'.repeat(65)],
];

for (const [what, spelling] of NOT_ADMITTED) {
  // The premise: this is genuinely something the peer's normaliser would rewrite.
  const rewritten = normalizeWorkspaceId(spelling) !== spelling;
  const asWorkspace = mintRemoteWorkspaceId('mac', spelling);
  const asPeer = mintRemoteWorkspaceId(spelling, 'board-tool');
  const refusedBoth = asWorkspace?.ok === false && asPeer?.ok === false;
  const saidSomething = typeof asWorkspace?.refusal === 'string' && asWorkspace.refusal.length > 20
    && typeof asPeer?.refusal === 'string' && asPeer.refusal.length > 20;
  const noId = asWorkspace?.id === undefined && asPeer?.id === undefined;
  check(`${what} is refused, as a project and as a peer`, rewritten && refusedBoth,
        JSON.stringify({ rewritten, asWorkspace, asPeer }));
  check('  and the refusal is a sentence, with nothing minted to fall back on',
        saidSomething && noId, JSON.stringify([asWorkspace, asPeer]));
}

for (const notAString of [null, undefined, 42, {}, ['a']]) {
  const result = mintRemoteWorkspaceId('mac', notAString);
  check(`${JSON.stringify(notAString) ?? 'undefined'} is refused rather than coerced`,
        result?.ok === false && typeof result.refusal === 'string', JSON.stringify(result));
}

// ─── 4. The budget, named in the sentence ─────────────────────────────────────

console.log('\n4. an id that cannot be namespaced inside 64 characters is refused by name');

const LIMIT = 64;

/** The longest project name that still fits behind this peer, found rather than assumed. */
let longestThatFits = '';
for (let length = 1; length <= LIMIT; length++) {
  const attempt = mintRemoteWorkspaceId('pc', 'a'.repeat(length));
  if (!attempt.ok) break;
  longestThatFits = 'a'.repeat(length);
}

const boundary = mintRemoteWorkspaceId('pc', longestThatFits);
check('there is a longest project name that fits behind a peer', longestThatFits.length > 0);
check('the id it mints is exactly at the limit the peer accepts',
      boundary.ok && boundary.id.length === LIMIT, JSON.stringify(boundary));
check('and that boundary id survives the peer\'s normaliser unchanged',
      boundary.ok && normalizeWorkspaceId(boundary.id) === boundary.id, JSON.stringify(boundary));
check('and splits back to the pair it was made from',
      JSON.stringify(splitRemoteWorkspaceId(boundary.id))
        === JSON.stringify({ peerId: 'pc', workspaceId: longestThatFits }),
      JSON.stringify(splitRemoteWorkspaceId(boundary.id)));

const oneTooLong = mintRemoteWorkspaceId('pc', `${longestThatFits}a`);
check('one character more is refused', oneTooLong?.ok === false, JSON.stringify(oneTooLong));
check('and the refusal names the budget it could not fit inside',
      oneTooLong?.ok === false && /\b64\b/.test(oneTooLong.refusal),
      JSON.stringify(oneTooLong?.refusal));
check('nothing is truncated: there is no id to reach for',
      oneTooLong?.id === undefined, JSON.stringify(oneTooLong));

const atTheLimit = mintRemoteWorkspaceId('pc', 'a'.repeat(LIMIT));
check(`a project name at ${LIMIT} characters — legal on its own machine — is refused here`,
      atTheLimit?.ok === false, JSON.stringify(atTheLimit));
check('and that refusal names the budget too',
      atTheLimit?.ok === false && /\b64\b/.test(atTheLimit.refusal),
      JSON.stringify(atTheLimit?.refusal));
check('and it does not collapse to the shared board',
      atTheLimit?.id !== COLLAPSE_TARGET && atTheLimit?.ok === false, JSON.stringify(atTheLimit));

// ─── 5. What is not one of ours does not split ────────────────────────────────

console.log('\n5. a local id is not a namespaced one, and a near miss is not either');

/** Ids this module never minted. Splitting one has to answer "not mine", not a guess. */
const NOT_OURS = [
  ['an ordinary local project', 'board-tool'],
  ['the shared board', COLLAPSE_TARGET],
  ['the empty string', ''],
  ['the prefix alone', 'peer.'],
  ['a project whose name starts like one', 'peerless'],
  ['uppercase, so not an id at all', 'PEER.02.PC.BOARD'],
];

for (const [what, spelling] of NOT_OURS) {
  check(`${what} does not split`, splitRemoteWorkspaceId(spelling) === null,
        JSON.stringify(splitRemoteWorkspaceId(spelling)));
  check('  and is not recognised as one of ours', recognises(spelling) === false,
        JSON.stringify(recognises(spelling)));
}

// A bijection is two identities and this is the second one: wherever splitting answers a
// pair, minting that pair has to give back exactly the string it was handed. Otherwise two
// spellings name one board, and the second of them is a board nobody can reach.
const canonical = mintRemoteWorkspaceId('pc', 'mirror');
check('the mint produces one spelling for a pair', canonical.ok, JSON.stringify(canonical));

/** Every one-character edit of a minted id: a deletion, and a doubled character. */
const neighbours = new Set();
for (let at = 0; at < canonical.id.length; at++) {
  neighbours.add(canonical.id.slice(0, at) + canonical.id.slice(at + 1));
  neighbours.add(canonical.id.slice(0, at) + canonical.id[at] + canonical.id.slice(at));
}
neighbours.delete(canonical.id);

const nonCanonical = [...neighbours, ...minted.keys()].filter((spelling) => {
  const back = splitRemoteWorkspaceId(spelling);
  if (back === null) return false;
  const again = mintRemoteWorkspaceId(back.peerId, back.workspaceId);
  return !again.ok || again.id !== spelling;
});
check('minting what splitting answered gives back the id it was handed — every row, and every '
      + 'one-character edit of one', nonCanonical.length === 0,
      nonCanonical.slice(0, 3).map((spelling) => `${JSON.stringify(spelling)} → `
        + JSON.stringify(splitRemoteWorkspaceId(spelling))).join(' | '));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
