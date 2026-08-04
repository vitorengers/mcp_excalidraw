#!/usr/bin/env node
/**
 * Checks what a settled founder action does when the blocker comes back, and that the history
 * the store keeps of it is bounded.
 *
 * Two rules, both in `core/founder-store.ts` alone, and both written against what the real
 * callers do rather than against what a store might want.
 *
 * **The re-open cooldown.** The producer in `server.ts` runs on every memo read — roughly every
 * thirty seconds while anything polls the board. Consider a founder who presses Done on an
 * action nothing can verify: `gh-billing` and `agent-usage-exhausted` are settled `cannot-say`
 * by `core/founder-verify.ts`, so the route takes the reader's word for it. If the blocker is
 * in fact still there, the next pass notices it again, and the next, and the next. A
 * re-detection **inside** the cooldown therefore re-opens the record that is already there —
 * `reopenedAt` stamped, `lastSeenAt` moved, `createdAt` where it was — and one that arrives
 * **after** it opens a second, distinct record, because "I bought credit and it ran out again"
 * is two events on the column rather than one card flickering.
 *
 * **Retention.** A settled record is the evidence that a blocker was fixed, so it is kept — but
 * the file is read on every poll, and a column's own history must not become the reason the
 * column is slow. Settled records that are past the age bound *and* beyond the per-key count
 * bound are pruned on write. An open record is never pruned whatever its age, because an old
 * open record is precisely the one that matters most; the most recent settled records per key
 * survive the age bound, so the last fix is always visible; and a record whose transcript is
 * still being appended to is left alone.
 *
 * Nine sections:
 *
 *  1. **the bounds are constants in this module**, and no setting anywhere names them, so no
 *     generated region of `docs/running.md` moves.
 *  2. **ten producer passes over a wrongly-trusted Done leave exactly one record**, open again,
 *     with `reopenedAt` stamped and `createdAt` where it was. **Red against #537's build**,
 *     which leaves the record settled and therefore leaves the blocker invisible for ever.
 *  3. **the re-opened record keeps its published item and is not published again** — measured
 *     both through the producer's own gate and through `publishFounderAction`'s.
 *  4. **after the cooldown it is a second event**: a distinct record with a later `createdAt`,
 *     its own empty transcript and no published item, with the first one left settled beside
 *     it. **Red against #537's build**, which cannot hold two records under one key at all.
 *  5. **an open record of any age is never pruned** — four hundred days old, and its key's own
 *     history pruned around it.
 *  6. **settled records past the age bound go on the next write, and the log names how many
 *     went and for which keys**, in the house style of `core/project-board.ts`'s card cap.
 *  7. **the most recent settled records per key survive the age bound**, and a key whose
 *     settled records are all young keeps every one of them.
 *  8. **a transcript still being appended to is never pruned**, beside a record identical to it
 *     but for a turn three hours old, which is.
 *  9. **the file round-trips**: a fresh import reads exactly what survived, the document is
 *     still a document, and the write left no temporary file behind.
 *
 * Sections 5 to 8 are red against #537's build for one reason with two faces: nothing is ever
 * pruned there, and the store cannot hold two records under one key, so the per-key history
 * these bounds exist to bound does not exist to be measured.
 *
 * Self-contained and offline: a throwaway state directory in the temp folder, no canvas server,
 * no child process, no browser and nothing asked of GitHub. It imports the built modules, so
 * run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-founder-store-retention.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const built = (module) => join(repoRoot, 'dist', 'core', `${module}.js`);

// ─── The throwaway directory, before the first import ─────────
//
// `utils/logger.ts` resolves its file at import and the store resolves its directory at every
// write, so both are pointed somewhere throwaway before anything under `dist/` loads. The log
// file is not incidental here: the pruning line is `info`, and the console transport is
// warn-and-above, so section 6 has nowhere else to read it from.

const workDir = join(tmpdir(), `founder-retention-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const stateDir = join(workDir, 'board-workspaces-state');
mkdirSync(stateDir, { recursive: true });

const logFile = join(workDir, 'canvas.log');
process.env.LOG_FILE_PATH = logFile;
process.env.VIBEMAXXING_NO_DOTENV = '1';
process.env.VIBEMAXXING_BOARD_STATE = stateDir;

const { FOUNDER_ACTION_CORPUS } = await import(pathToFileURL(built('founder-action-text')).href);
const { founderActionFor } = await import(pathToFileURL(built('founder-blockers')).href);
const { publishFounderAction } = await import(pathToFileURL(built('founder-publish')).href);

const storeUrl = pathToFileURL(built('founder-store')).href;
const {
  appendChatTurn, founderActionKey, founderActionsFile, listFounderActions, openFounderActions,
  readFounderAction, recordFounderAction,
} = await import(storeUrl);

/**
 * The bounds, as this check reads them.
 *
 * Written out here rather than imported, because they are deliberately not exported: they are
 * constants of that module and not settings, and section 1 holds them to being declared there.
 * A value that moves reds this file, which is the point — the cases below are written around
 * these widths and somebody changing one has to come and read them.
 */
const COOLDOWN_MS = 60 * 60 * 1000;
const SETTLED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SETTLED_PER_KEY = 3;
const CHAT_SETTLING_MS = 30 * 60 * 1000;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A record the register accepts, so a seeded fixture is a real card rather than a shape. */
const GOOD = FOUNDER_ACTION_CORPUS['gh-billing'];

const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** One seeded record, written the way the store writes one. */
function seedRecord(workspaceId, kind, discriminator, over = {}) {
  const key = founderActionKey(workspaceId, kind, discriminator);
  const createdAt = over.createdAt ?? ago(2 * DAY);
  return {
    key,
    kind,
    workspaceId,
    fields: FOUNDER_ACTION_CORPUS[kind] ?? GOOD,
    evidence: { source: 'scripts/check-founder-store-retention.mjs' },
    state: 'resolved',
    createdAt,
    lastSeenAt: over.resolvedAt ?? createdAt,
    resolvedAt: over.resolvedAt ?? createdAt,
    resolvedBy: 'person',
    chat: [],
    ...over,
  };
}

/** A whole workspace file, put on disk before the store has ever looked at that workspace. */
function seed(workspaceId, actions) {
  writeFileSync(founderActionsFile(workspaceId), `${JSON.stringify({
    type: 'founder-actions',
    version: 1,
    workspaceId,
    savedAt: new Date().toISOString(),
    actions,
  })}\n`, 'utf8');
}

/**
 * One producer pass, as `noticeFounderBlocker` in `server.ts` makes one.
 *
 * The read before the write, the record, and the publish gate, in that order and with the same
 * condition on the last of them — so "it was not published again" is measured here in the terms
 * the only real producer uses rather than in terms of its own.
 */
const published = [];
function producerPass(workspaceId, kind, discriminator) {
  const blocker = { kind, key: kind, discriminator, named: {}, evidence: {} };
  const written = recordFounderAction({
    workspaceId,
    kind,
    discriminator,
    fields: founderActionFor(blocker),
    evidence: { source: 'scripts/check-founder-store-retention.mjs' },
  });
  if (written.ok && written.record && !written.record.publishedItemId) {
    published.push(written.record.key);
  }
  return written;
}

// ─── 1. The bounds are constants in this module ───────────────

console.log('1. the two bounds and the cooldown are constants in the store, and no setting');

const source = readFileSync(join(repoRoot, 'src', 'core', 'founder-store.ts'), 'utf8');
const declared = (name, value) => new RegExp(`^const ${name}\\s*=\\s*${value}`, 'm').test(source);

check('the cooldown is declared there, in whole hours',
      declared('REOPEN_COOLDOWN_MS', '60 \\* 60 \\* 1000'), 'REOPEN_COOLDOWN_MS');
check('the age bound is declared there, in whole days',
      declared('SETTLED_MAX_AGE_MS', '30 \\* 24 \\* 60 \\* 60 \\* 1000'), 'SETTLED_MAX_AGE_MS');
check('the count bound is declared there', declared('SETTLED_PER_KEY', '3'), 'SETTLED_PER_KEY');
check('and so is how long a transcript is treated as unfinished',
      declared('CHAT_SETTLING_MS', '30 \\* 60 \\* 1000'), 'CHAT_SETTLING_MS');

const settings = readFileSync(join(repoRoot, 'src', 'core', 'settings.ts'), 'utf8');
const named = ['REOPEN_COOLDOWN_MS', 'SETTLED_MAX_AGE_MS', 'SETTLED_PER_KEY', 'CHAT_SETTLING_MS']
  .filter((name) => settings.includes(name));
check('none of them is a setting — the settings register names none of them', named.length === 0,
      named.join(', '));
check('and the store exports none of them either, so nothing can be tuned round the back',
      !/^export const (REOPEN_COOLDOWN_MS|SETTLED_MAX_AGE_MS|SETTLED_PER_KEY|CHAT_SETTLING_MS)/m
        .test(source));

// ─── 2. A wrongly-trusted Done, ten passes ────────────────────

console.log('\n2. ten passes over a Done nothing could verify leave one record, open again');

const TRUSTED = 'ws-trusted';
const trustedKey = founderActionKey(TRUSTED, 'gh-billing');
const trustedCreatedAt = ago(2 * DAY);

// Settled by the person, thirty seconds ago, and nothing can look again at a bill: this is the
// exact shape `POST /api/founder-actions/resolve` leaves behind when a `cannot-say` kind is
// pressed Done and the board takes the reader's word for it.
seed(TRUSTED, [seedRecord(TRUSTED, 'gh-billing', undefined, {
  createdAt: trustedCreatedAt,
  resolvedAt: ago(30 * 1000),
  lastSeenAt: ago(30 * 1000),
  resolvedBy: 'person',
  publishedItemId: 'PVTI_trusted',
})]);

const PASSES = 10;
for (let pass = 0; pass < PASSES; pass++) {
  producerPass(TRUSTED, 'gh-billing', undefined);
  await sleep(2);
}

const trusted = listFounderActions(TRUSTED);
check(`${PASSES} passes left exactly one record, not ${PASSES}`, trusted.length === 1,
      `${trusted.length} record(s): ${trusted.map((one) => one.createdAt).join(', ')}`);

const reopened = readFounderAction(TRUSTED, trustedKey);
check('and the blocker is back on the column rather than buried', reopened?.state === 'open',
      `it is ${reopened?.state}`);
check('the record says when it was re-opened',
      typeof reopened?.reopenedAt === 'string' && !Number.isNaN(Date.parse(reopened.reopenedAt)),
      String(reopened?.reopenedAt));
check('and that is after it was settled',
      String(reopened?.reopenedAt) > String(reopened?.resolvedAt ?? ''),
      `${reopened?.resolvedAt} then ${reopened?.reopenedAt}`);
check('its createdAt did not move — this is the same event it always was',
      reopened?.createdAt === trustedCreatedAt,
      `${trustedCreatedAt} became ${reopened?.createdAt}`);
check('its lastSeenAt did', String(reopened?.lastSeenAt) > trustedCreatedAt,
      String(reopened?.lastSeenAt));
check('the open list has it, once', openFounderActions(TRUSTED).length === 1,
      `${openFounderActions(TRUSTED).length} open`);

// ─── 3. Re-opened, and not published a second time ────────────

console.log('\n3. a re-opened record keeps its published item, and is not published again');

check('the draft item it was published as is still on the record',
      reopened?.publishedItemId === 'PVTI_trusted', String(reopened?.publishedItemId));
check(`none of the ${PASSES} passes reached the publish gate`, published.length === 0,
      published.join(', '));

/**
 * A board with nothing to publish to, so a guard that failed cannot reach GitHub.
 *
 * `publishFounderAction` reads the store before it spawns anything and answers the id the record
 * already carries. Publication is turned off and there is no project either, so the two arms
 * below the guard both answer null without a process: a failure here is a wrong answer rather
 * than a `gh` this check went and ran.
 */
const nowhere = { id: TRUSTED, githubProject: null, projectFounderPublishOff: true };
const republished = await publishFounderAction(nowhere, reopened);
check('and publishing it again answers the item it already has, without filing a second',
      republished === 'PVTI_trusted', String(republished));

// ─── 4. After the cooldown, a second event ────────────────────

console.log('\n4. a re-detection after the cooldown is a second event, not a flicker');

const AGAIN = 'ws-again';
const againKey = founderActionKey(AGAIN, 'gh-billing');
const firstCreatedAt = ago(5 * DAY);

seed(AGAIN, [seedRecord(AGAIN, 'gh-billing', undefined, {
  createdAt: firstCreatedAt,
  resolvedAt: ago(3 * HOUR),
  lastSeenAt: ago(3 * HOUR),
  resolvedBy: 'person',
  publishedItemId: 'PVTI_first_time',
  chat: [{ role: 'founder', text: 'Card is on the account now.', at: ago(3 * HOUR) }],
})]);

check('the seeded settlement really is past the cooldown', 3 * HOUR > COOLDOWN_MS);

producerPass(AGAIN, 'gh-billing', undefined);

const twice = listFounderActions(AGAIN);
check('the key now holds two records', twice.length === 2,
      `${twice.length}: ${twice.map((one) => `${one.state}@${one.createdAt}`).join(', ')}`);

const second = readFounderAction(AGAIN, againKey);
check('reading the key answers the new one', String(second?.createdAt) > firstCreatedAt,
      `${firstCreatedAt} / ${second?.createdAt}`);
check('and it is open', second?.state === 'open', second?.state);
check('it was never re-opened, because it was never settled', second?.reopenedAt === undefined,
      String(second?.reopenedAt));
check('it carries no published item, so the recurrence reaches the column as its own card',
      second?.publishedItemId === undefined, String(second?.publishedItemId));
check('and its transcript starts empty rather than continuing the last one\'s',
      second?.chat?.length === 0, `${second?.chat?.length} turn(s)`);

const first = twice.find((one) => one.createdAt === firstCreatedAt);
check('the record of the first time is still there, settled', first?.state === 'resolved',
      String(first?.state));
check('with the draft item it was published as', first?.publishedItemId === 'PVTI_first_time');
check('and with the conversation that was had about it', first?.chat?.length === 1);
check('only one of the two is open', openFounderActions(AGAIN).length === 1,
      `${openFounderActions(AGAIN).length} open`);

for (let pass = 0; pass < PASSES; pass++) producerPass(AGAIN, 'gh-billing', undefined);
check(`and ${PASSES} more passes add nothing — the dedupe still holds on the open one`,
      listFounderActions(AGAIN).length === 2, `${listFounderActions(AGAIN).length} record(s)`);

// ─── 5 to 8. The history, and what bounds it ──────────────────
//
// One workspace, seeded with four keys whose timelines are each a different case, and one write
// to make the store prune. The expectations are written out per key rather than computed, so a
// rule that changed under this file would be read by somebody rather than followed by it.

console.log('\n5. an open record of any age is never pruned');

const HISTORY = 'ws-history';
const RATE = founderActionKey(HISTORY, 'gh-rate-limit');
const BILLING = founderActionKey(HISTORY, 'gh-billing');
const LOGIN = founderActionKey(HISTORY, 'gh-login');
const USAGE = founderActionKey(HISTORY, 'agent-usage-exhausted', 'native');

const openCreatedAt = ago(400 * DAY);

/** Six fixes long past the age bound, and one still-open record older than every one of them. */
const rateLimit = [
  ...[500, 480, 460, 440, 420, 410].map((days) => seedRecord(HISTORY, 'gh-rate-limit', undefined, {
    createdAt: ago((days + 1) * DAY), resolvedAt: ago(days * DAY), lastSeenAt: ago(days * DAY),
  })),
  seedRecord(HISTORY, 'gh-rate-limit', undefined, {
    state: 'open', createdAt: openCreatedAt, lastSeenAt: ago(MINUTE),
    resolvedAt: undefined, resolvedBy: undefined,
  }),
];

/** Five fixes past the age bound and nothing else: three survive, two go. */
const billing = [200, 180, 160, 140, 120].map((days) =>
  seedRecord(HISTORY, 'gh-billing', undefined, {
    createdAt: ago((days + 1) * DAY), resolvedAt: ago(days * DAY), lastSeenAt: ago(days * DAY),
  }));

/** Four fixes, every one of them inside the age bound: the count bound prunes none of them. */
const login = [20, 15, 10, 5].map((days) => seedRecord(HISTORY, 'gh-login', undefined, {
  createdAt: ago((days + 1) * DAY), resolvedAt: ago(days * DAY), lastSeenAt: ago(days * DAY),
}));

/**
 * Five fixes past the age bound, of which the two oldest are past the count bound too — and one
 * of those two is being talked about right now. A turn a minute old is a transcript still being
 * appended to; one three hours old is a conversation that finished.
 */
const usage = [
  seedRecord(HISTORY, 'agent-usage-exhausted', 'native', {
    createdAt: ago(401 * DAY), resolvedAt: ago(400 * DAY), lastSeenAt: ago(400 * DAY),
    chat: [{ role: 'founder', text: 'What did this one turn out to be?', at: ago(MINUTE) }],
  }),
  seedRecord(HISTORY, 'agent-usage-exhausted', 'native', {
    createdAt: ago(391 * DAY), resolvedAt: ago(390 * DAY), lastSeenAt: ago(390 * DAY),
    chat: [{ role: 'founder', text: 'And this one?', at: ago(3 * HOUR) }],
  }),
  ...[380, 370, 360].map((days) =>
    seedRecord(HISTORY, 'agent-usage-exhausted', 'native', {
      createdAt: ago((days + 1) * DAY), resolvedAt: ago(days * DAY), lastSeenAt: ago(days * DAY),
    })),
];

seed(HISTORY, [...rateLimit, ...billing, ...login, ...usage]);

const SEEDED = rateLimit.length + billing.length + login.length + usage.length;
check(`a key's whole history is read back, not the last record of it — ${SEEDED} records`,
      listFounderActions(HISTORY).length === SEEDED,
      `the store read ${listFounderActions(HISTORY).length} of them back`);

// The write that prunes. A blocker on a key of its own, so nothing here is the pruning of the
// record being written.
producerPass(HISTORY, 'gh-scope', undefined);

const held = (key) => listFounderActions(HISTORY).filter((one) => one.key === key);

check('the four-hundred-day-old open record is still there',
      held(RATE).some((one) => one.createdAt === openCreatedAt && one.state === 'open'),
      held(RATE).map((one) => `${one.state}@${one.createdAt}`).join(', '));
check('and the open list still has it', openFounderActions(HISTORY)
        .some((one) => one.createdAt === openCreatedAt), 'the oldest open record went');
check('while its key\'s own history was pruned around it',
      held(RATE).length === SETTLED_PER_KEY + 1, `${held(RATE).length} under ${RATE}`);

console.log('\n6. settled records past the age bound go on the next write, and the log says so');

check('the key with five old fixes kept the count bound and no more',
      held(BILLING).length === SETTLED_PER_KEY, `${held(BILLING).length} under ${BILLING}`);

const KEPT = SETTLED_PER_KEY + SETTLED_PER_KEY + login.length + (SETTLED_PER_KEY + 1);
const PRUNED = SEEDED - KEPT - 1; // less the one open record, which was never a settled one
check(`${PRUNED} of the ${SEEDED - 1} settled records went`,
      listFounderActions(HISTORY).length === KEPT + 1 + 1,
      `${listFounderActions(HISTORY).length} records, including the open one and the new one`);

let logged = '';
for (let attempt = 0; attempt < 40 && !/is keeping/.test(logged); attempt++) {
  await sleep(50);
  try { logged = readFileSync(logFile, 'utf8'); } catch { /* winston has not landed it yet */ }
}
const pruning = logged.split('\n').filter((line) => line.includes('is keeping'));
check('the log has a line about it at all', pruning.length > 0,
      logged.split('\n').filter(Boolean).slice(-3).join(' | ') || '(the log file is empty)');
check('it names the workspace and how many of the settled records it left',
      pruning.some((line) => line.includes(`"${HISTORY}"`)
        && line.includes(`is keeping ${SEEDED - 1 - PRUNED} of ${SEEDED - 1} settled records`)),
      pruning.join(' | '));
check('and it names what it removed, key by key',
      pruning.some((line) => line.includes(`3 for ${RATE}`) && line.includes(`2 for ${BILLING}`)
        && line.includes(`1 for ${USAGE}`)),
      pruning.join(' | '));
check('the key that lost nothing is not named', !pruning.some((line) => line.includes(LOGIN)),
      pruning.join(' | '));

console.log('\n7. the most recent settled records per key survive the age bound');

const oldest = (key) => held(key).map((one) => one.resolvedAt).sort();
check('the three that survived are the three most recent fixes, not the first three',
      oldest(BILLING).every((at) => Date.now() - Date.parse(at) < 165 * DAY),
      oldest(BILLING).join(', '));
check('so the last fix for that blocker is still visible',
      Math.min(...held(BILLING).map((one) => Date.now() - Date.parse(one.resolvedAt))) < 125 * DAY,
      oldest(BILLING).join(', '));
check('and a key whose fixes are all inside the age bound keeps every one of them',
      held(LOGIN).length === login.length, `${held(LOGIN).length} of ${login.length}`);
check('even though there are more of them than the count bound', login.length > SETTLED_PER_KEY);

console.log('\n8. a transcript still being appended to is never pruned');

const talking = held(USAGE).find((one) => one.createdAt === usage[0].createdAt);
const finished = held(USAGE).find((one) => one.createdAt === usage[1].createdAt);
check('the record being talked about a minute ago survived, past both bounds',
      Boolean(talking), `${held(USAGE).length} under ${USAGE}`);
check('with its turn intact', talking?.chat?.length === 1, `${talking?.chat?.length} turn(s)`);
check('and the one whose conversation finished three hours ago did not — so this is a case',
      finished === undefined, 'both of them survived, which measures nothing');
check('a turn three hours old is well past how long a turn is given',
      3 * HOUR > CHAT_SETTLING_MS);

// A turn appended now on a record that was about to be pruned holds it, which is the rule from
// the other side: the store is written on every turn, and a prune that ran between the founder's
// message and the agent's answer would take the record out from under the reply.
const stillTalking = appendChatTurn(HISTORY, RATE, { role: 'founder', text: 'Is this one back?' });
check('appending a turn is itself a write, and it did not prune what it was writing to',
      stillTalking !== null && held(RATE).length === SETTLED_PER_KEY + 1,
      `${held(RATE).length} under ${RATE}`);

// ─── 9. The file after the pruning ────────────────────────────

console.log('\n9. the pruned file is still a document, and a fresh import reads it');

const historyFile = String(founderActionsFile(HISTORY));
const raw = readFileSync(historyFile, 'utf8');
let document = null;
try { document = JSON.parse(raw); } catch { /* the case below reports it */ }

check('the file parses', document !== null, raw.slice(0, 200));
check('and it is still a named document', document?.type === 'founder-actions'
      && document?.version === 1 && document?.workspaceId === HISTORY,
      JSON.stringify({ type: document?.type, version: document?.version }));
check('the pruned records are gone from the disk too',
      Array.isArray(document?.actions) && document.actions.length === listFounderActions(HISTORY).length,
      `${document?.actions?.length} on disk, ${listFounderActions(HISTORY).length} in memory`);

const restarted = await import(`${storeUrl}?after-prune=1`);
check('a fresh instance reads exactly what survived',
      restarted.listFounderActions(HISTORY).length === listFounderActions(HISTORY).length,
      `${restarted.listFounderActions(HISTORY).length} came back`);
check('the open record among them is still open',
      restarted.openFounderActions(HISTORY).some((one) => one.createdAt === openCreatedAt));
check('the re-opened record comes back re-opened, with its published item',
      restarted.readFounderAction(TRUSTED, trustedKey)?.state === 'open'
      && restarted.readFounderAction(TRUSTED, trustedKey)?.reopenedAt === reopened?.reopenedAt
      && restarted.readFounderAction(TRUSTED, trustedKey)?.publishedItemId === 'PVTI_trusted',
      JSON.stringify(restarted.readFounderAction(TRUSTED, trustedKey)?.state));
check('and both of the recurrence\'s records come back, one open and one settled',
      restarted.listFounderActions(AGAIN).length === 2
      && restarted.openFounderActions(AGAIN).length === 1,
      `${restarted.listFounderActions(AGAIN).length} record(s)`);

const leftovers = readdirSync(stateDir).filter((name) => name.includes('.tmp'));
check('the writes left no temporary file behind', leftovers.length === 0, leftovers.join(', '));

// ─── Teardown ────────────────────────────────────────────────
//
// Inside a try/catch: a removal that fails is a Windows file lock in a temporary directory, and
// a green run must not be turned red by one (`scripts/lib/teardown-scan.mjs`).

try { rmSync(workDir, { recursive: true, force: true }); } catch { /* it is a temp directory */ }

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
