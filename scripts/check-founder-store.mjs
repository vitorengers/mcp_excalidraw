#!/usr/bin/env node
/**
 * Checks that a founder action outlives the process that noticed it.
 *
 * An implement run cannot survive its server, and `core/implement-state.ts` is a plain
 * in-memory map because of it: the worktree is what persists, and the map is rebuilt from git
 * at startup. A founder block is the opposite shape. The credit is still missing after a
 * restart, the sign-in is still expired, and a record held only in memory would re-file the
 * same card on every boot and lose every Done a person had already given it.
 *
 * So `core/founder-store.ts` writes, and this is the file that holds it to writing. Eleven
 * sections, in the order that makes the later ones mean anything:
 *
 *  1. **the doors.** Seven functions record, read, list, settle and add to the chat, and they
 *     are the only way in. A producer that reaches past them is a producer whose text was
 *     never measured.
 *  2. **a record recorded is a record read back**, with the key the store composed rather than
 *     one a producer typed.
 *  3. **the register is enforced at the write.** `validateFounderAction` refuses, the fault
 *     list comes back, and nothing invalid is ever readable — including over a key that
 *     already holds a good record.
 *  4. **one key is one record.** The dedupe is the point of the key: the same blocker is
 *     discovered by the project poll, the issue panel, the queue's dependency reads and every
 *     implement start, and four producers must leave one card. Recording an existing key moves
 *     `lastSeenAt` and nothing else.
 *  5. **two workspaces holding the same key do not see each other's.**
 *  6. **settled, and left settled.** Resolve names who settled it; dismiss is a person's. A
 *     settled key that is recorded again stays settled — the re-open rule is #545's, on
 *     purpose, because it needs real callers before it can be written against what they do.
 *  7. **a chat turn is not register-validated.** A stack trace and 300 characters of stderr
 *     are stored intact, and the same text in a founder field is refused. Conflating the two
 *     is the obvious mistake, so both halves are asserted in one place.
 *  8. **a record outlives the process.** A freshly imported instance pointed at the same
 *     directory reads state and chat back — the module cache busted with a query string,
 *     standing in for a restart. **Red against a module-level map.**
 *  9. **a truncated, empty or non-JSON file reads as empty, with a warning, and never
 *     throws** — and the next record repairs it. **Red against a map**, which has no file to
 *     be wrong about and therefore warns about nothing.
 * 10. **no directory to write to.** `boardStateDir()` returns `string | null` and its own
 *     comment says null is reachable; a board must still start. A child process stubs that
 *     module through a `module.register()` load hook — the resolution seam
 *     `check-pty-fallback-reason.mjs` uses, because a null answer cannot be reached through
 *     the environment: `registryPath()` falls back to a real path in the per-user state
 *     directory when nothing is set. **Red against a map**, for the warning.
 * 11. **the file is written atomically.** A second process parses it on every tick while two
 *     hundred records are written, and never sees a partial document. A reader in *this*
 *     process would prove nothing — the writes are synchronous, so nothing could interleave
 *     with them here. **Red against a map**: the reader never finds a file at all.
 *
 * Self-contained and offline: a throwaway state directory in the temp folder, two short-lived
 * child processes, no canvas server, no browser and nothing asked of GitHub. It imports the
 * built module, so run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-founder-store.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const url = (file) => JSON.stringify(pathToFileURL(file).href);
const built = (module) => join(repoRoot, 'dist', 'core', `${module}.js`);

// ─── The throwaway directory, and the environment before the first import ────
//
// Both have to be in place before anything under `dist/` is loaded: `utils/logger.ts` resolves
// its file at import, and a check that skipped this would write its warnings into the log the
// maintainer reads. `NO_DOTENV` seals the two file layers off, so this run is decided by what
// is set here and by nothing that happens to be on the machine.

const workDir = join(tmpdir(), `founder-store-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const stateDir = join(workDir, 'board-workspaces-state');
mkdirSync(stateDir, { recursive: true });

process.env.LOG_FILE_PATH = join(workDir, 'canvas.log');
process.env.VIBEMAXXING_NO_DOTENV = '1';
process.env.VIBEMAXXING_BOARD_STATE = stateDir;

const {
  FOUNDER_ACTION_CORPUS, validateFounderAction,
} = await import(pathToFileURL(built('founder-action-text')).href);

const storeUrl = pathToFileURL(built('founder-store')).href;
const store = await import(storeUrl);

const {
  appendChatTurn, dismissFounderAction, founderActionKey, founderActionsFile,
  listFounderActions, openFounderActions, readFounderAction, recordFounderAction,
  resolveFounderAction,
} = store;

/** A record the register accepts, so a fixture is exactly one field away from valid. */
const GOOD = FOUNDER_ACTION_CORPUS['gh-login'];

/**
 * What a store call said on the console while it ran.
 *
 * `utils/logger.ts` sends `warn` and above to stderr and everything else to a file, so this is
 * where a warning about a file nobody could read shows up. Scoped to the one call rather than
 * installed for the run: `check()` prints its own failures to stderr, and a capture left in
 * place would swallow the evidence of the very case that failed.
 */
function said(run) {
  const heard = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    heard.push(String(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  try {
    const value = run();
    return { value, console: heard.join('') };
  } finally {
    process.stderr.write = real;
  }
}

// ─── 1. The doors ────────────────────────────────────────────

console.log('1. seven doors in, and nothing else writes a record');

const DOORS = [
  'recordFounderAction', 'readFounderAction', 'openFounderActions', 'listFounderActions',
  'resolveFounderAction', 'dismissFounderAction', 'appendChatTurn',
];

for (const door of DOORS) {
  check(`it exports ${door}`, typeof store[door] === 'function', `it is ${typeof store[door]}`);
}
check('and the key a producer reuses is composed here rather than typed',
      typeof founderActionKey === 'function');
check('and a caller can be told which file a workspace is kept in',
      typeof founderActionsFile === 'function');

const source = readFileSync(join(repoRoot, 'src', 'core', 'founder-store.ts'), 'utf8');
const exported = [...source.matchAll(/^export function (\w+)/gm)].map(([, name]) => name);
const strays = exported.filter((name) => !DOORS.includes(name)
  && !['founderActionKey', 'founderActionsFile'].includes(name));
check('and exports no other function at all', strays.length === 0, strays.join(', '));

// ─── 2. A record recorded is a record read back ──────────────

console.log('\n2. a record recorded is a record read back');

const ALPHA = 'ws-alpha';
const first = recordFounderAction({ workspaceId: ALPHA, kind: 'gh-login', fields: GOOD });

check('recording a good record is accepted', first.ok === true,
      first.faults?.map((fault) => `${fault.field}/${fault.rule}`).join(', '));
check('the store composed the key', first.record?.key === `${ALPHA}:gh-login`, first.record?.key);
check('the key is workspace, kind and the discriminator when there is one',
      founderActionKey(ALPHA, 'gh-scope', 'octo-founder/pantry') === `${ALPHA}:gh-scope:octo-founder/pantry`,
      founderActionKey(ALPHA, 'gh-scope', 'octo-founder/pantry'));
check('a new record is open', first.record?.state === 'open', first.record?.state);
check('it carries the workspace it belongs to', first.record?.workspaceId === ALPHA);
check('it was first seen when it was created',
      typeof first.record?.createdAt === 'string' && first.record.createdAt === first.record.lastSeenAt,
      `${first.record?.createdAt} / ${first.record?.lastSeenAt}`);
check('the times are instants anything can read',
      !Number.isNaN(Date.parse(first.record?.createdAt ?? '')), first.record?.createdAt);
check('its chat starts empty', Array.isArray(first.record?.chat) && first.record.chat.length === 0);
check('it has settled nothing yet',
      first.record?.resolvedAt === undefined && first.record?.resolvedBy === undefined);
check('and the fields are the ones handed over',
      first.record?.fields?.title === GOOD.title && first.record?.fields?.steps?.length === GOOD.steps.length);

const readBack = readFounderAction(ALPHA, `${ALPHA}:gh-login`);
check('reading it by key answers the same record',
      JSON.stringify(readBack) === JSON.stringify(first.record), JSON.stringify(readBack));
check('a key nothing was recorded under answers nothing',
      readFounderAction(ALPHA, `${ALPHA}:gh-billing`) === null);
check('listing the workspace finds it', listFounderActions(ALPHA).length === 1);
check('and it is open', openFounderActions(ALPHA).map((record) => record.key).join() === `${ALPHA}:gh-login`);

/**
 * A door that hands back the record it is holding is a door somebody can write through without
 * going through it: the caller edits the object, the store never knows, and the file on disk
 * and the board disagree for the rest of the process. In its own workspace, because a case
 * that fails here has by then written something nothing sanctioned.
 */
const COPIES = 'ws-copies';
recordFounderAction({ workspaceId: COPIES, kind: 'gh-login', fields: GOOD });
const handed = readFounderAction(COPIES, `${COPIES}:gh-login`);
handed.state = 'dismissed';
handed.chat.push({ role: 'founder', text: 'written round the back', at: new Date().toISOString() });
check('a reader cannot write through the record it was handed',
      readFounderAction(COPIES, `${COPIES}:gh-login`)?.state === 'open'
      && readFounderAction(COPIES, `${COPIES}:gh-login`)?.chat.length === 0,
      `${readFounderAction(COPIES, `${COPIES}:gh-login`)?.state}, `
      + `${readFounderAction(COPIES, `${COPIES}:gh-login`)?.chat.length} turn(s)`);

// ─── 3. The register is enforced at the write ────────────────

console.log('\n3. the register is enforced at the write, and this is the only door');

const BETA = 'ws-beta';
const bad = recordFounderAction({
  workspaceId: BETA,
  kind: 'gh-login',
  fields: { ...GOOD, title: '   ', what: 'The board decided this in src/core/gh.ts and stopped.' },
});

check('a record the register refuses is refused here', bad.ok === false);
check('and the fault list comes back rather than the text going in',
      Array.isArray(bad.faults) && bad.faults.length >= 2,
      JSON.stringify(bad.faults));
check('every fault names the field it broke a rule in',
      (bad.faults ?? []).every((fault) => typeof fault.field === 'string' && typeof fault.rule === 'string'),
      JSON.stringify(bad.faults));
check('the faults are the register\'s own, rule for rule',
      JSON.stringify(bad.faults)
        === JSON.stringify(validateFounderAction({ ...GOOD, title: '   ',
          what: 'The board decided this in src/core/gh.ts and stopped.' }).faults),
      JSON.stringify(bad.faults));
check('nothing was stored', bad.record === null && readFounderAction(BETA, `${BETA}:gh-login`) === null);
check('and the workspace is still empty', listFounderActions(BETA).length === 0);

const strange = recordFounderAction({ workspaceId: BETA, kind: 'nothing-like-this', fields: GOOD });
check('a kind outside the register is refused too', strange.ok === false
      && (strange.faults ?? []).some((fault) => fault.field === 'kind'),
      JSON.stringify(strange.faults));

const overwritten = recordFounderAction({
  workspaceId: ALPHA, kind: 'gh-login', fields: { ...GOOD, confirm: '' },
});
check('a bad record over a good key is refused', overwritten.ok === false);
check('and the good record it would have replaced is untouched',
      JSON.stringify(readFounderAction(ALPHA, `${ALPHA}:gh-login`)) === JSON.stringify(first.record),
      'an invalid write moved something');

// ─── 4. One key is one record ────────────────────────────────

console.log('\n4. one key is one record, and recording it again moves lastSeenAt and nothing else');

// Read off the record before the second write rather than from it afterwards: a store that
// hands out its own object would otherwise have moved this string too, and the comparison
// would be a record against itself.
const firstSeenAt = String(first.record?.lastSeenAt);
const firstCreatedAt = String(first.record?.createdAt);

await sleep(12);
const again = recordFounderAction({
  workspaceId: ALPHA,
  kind: 'gh-login',
  fields: { ...GOOD, title: 'Sign the tool in to the account that owns it' },
});

check('recording the same key again is accepted', again.ok === true);
check('there is still one record', listFounderActions(ALPHA).length === 1, `${listFounderActions(ALPHA).length}`);
check('its createdAt did not move', again.record?.createdAt === firstCreatedAt,
      `${firstCreatedAt} became ${again.record?.createdAt}`);
check('its lastSeenAt did', String(again.record?.lastSeenAt) > firstSeenAt,
      `${firstSeenAt} became ${again.record?.lastSeenAt}`);
check('and nothing else moved with it — the second producer\'s wording is not the card',
      again.record?.fields?.title === GOOD.title, again.record?.fields?.title);

const discriminated = recordFounderAction({
  workspaceId: ALPHA, kind: 'gh-login', discriminator: 'other-account', fields: GOOD,
});
check('a discriminator makes it a different blocker', discriminated.record?.key === `${ALPHA}:gh-login:other-account`
      && listFounderActions(ALPHA).length === 2, discriminated.record?.key);

// ─── 5. Per workspace ────────────────────────────────────────

console.log('\n5. records are per workspace');

const GAMMA = 'ws-gamma';
const elsewhere = recordFounderAction({ workspaceId: GAMMA, kind: 'gh-login', fields: GOOD });

check('the same kind in another workspace is another key',
      elsewhere.record?.key === `${GAMMA}:gh-login`, elsewhere.record?.key);
check('and that workspace holds only its own', listFounderActions(GAMMA).length === 1);
check('while the first one is unchanged', listFounderActions(ALPHA).length === 2);
check('neither can read the other\'s key',
      readFounderAction(GAMMA, `${ALPHA}:gh-login`) === null
      && readFounderAction(ALPHA, `${GAMMA}:gh-login`) === null);
check('and they are kept in different files',
      founderActionsFile(ALPHA) !== founderActionsFile(GAMMA),
      String(founderActionsFile(ALPHA)));

// ─── 6. Settled, and left settled ────────────────────────────

console.log('\n6. a settled key is settled, and this issue leaves it that way');

const resolved = resolveFounderAction(ALPHA, `${ALPHA}:gh-login`, 'probe');
check('resolving says so', resolved?.state === 'resolved', resolved?.state);
check('and says who settled it', resolved?.resolvedBy === 'probe'
      && typeof resolved?.resolvedAt === 'string', JSON.stringify(resolved?.resolvedBy));
check('the open list drops it',
      openFounderActions(ALPHA).map((record) => record.key).join() === `${ALPHA}:gh-login:other-account`,
      openFounderActions(ALPHA).map((record) => record.key).join());
check('and the full list keeps it', listFounderActions(ALPHA).length === 2);

const settledSeenAt = String(resolved?.lastSeenAt);
await sleep(12);
const settledAgain = recordFounderAction({ workspaceId: ALPHA, kind: 'gh-login', fields: GOOD });
check('recording a settled key leaves it settled', settledAgain.record?.state === 'resolved',
      settledAgain.record?.state);
check('but still records that it was seen again',
      String(settledAgain.record?.lastSeenAt) > settledSeenAt,
      `${settledSeenAt} became ${settledAgain.record?.lastSeenAt}`);
check('and it did not come back on the open list', openFounderActions(ALPHA).length === 1);

const dismissed = dismissFounderAction(ALPHA, `${ALPHA}:gh-login:other-account`);
check('dismissing says so', dismissed?.state === 'dismissed', dismissed?.state);
check('and a dismissal is always a person\'s', dismissed?.resolvedBy === 'person', dismissed?.resolvedBy);
check('nothing is open in that workspace now', openFounderActions(ALPHA).length === 0);
check('settling a key nothing holds answers nothing',
      resolveFounderAction(ALPHA, `${ALPHA}:gh-rate-limit`, 'person') === null
      && dismissFounderAction(ALPHA, `${ALPHA}:gh-rate-limit`) === null);

// ─── 7. The chat is not the card ─────────────────────────────

console.log('\n7. a chat turn is prose in a panel, and the register never reads it');

const STDERR = `HTTP 403: Resource not accessible by personal access token. ${'x'.repeat(300)}`;
const TRACE = 'Error: gh exited with 1\n'
  + '    at classifyGhFailure (src/core/gh.ts:214:11)\n'
  + '    at runGh (src/core/gh.ts:301:9)';
const TURN_TEXT = `${TRACE}\n\n${STDERR}`;

const chatted = appendChatTurn(GAMMA, `${GAMMA}:gh-login`, { role: 'agent', text: TURN_TEXT });
check('a turn carrying a stack trace and 300 characters of stderr is stored',
      chatted?.chat?.length === 1, JSON.stringify(chatted?.chat?.length));
check('and it is stored intact, byte for byte', chatted?.chat?.[0]?.text === TURN_TEXT,
      `${chatted?.chat?.[0]?.text?.length} characters of ${TURN_TEXT.length}`);
check('the stderr tail alone is over 300 characters, so this is the case it says it is',
      STDERR.length > 300, `${STDERR.length}`);
check('a turn is stamped and knows who said it',
      chatted?.chat?.[0]?.role === 'agent' && !Number.isNaN(Date.parse(chatted?.chat?.[0]?.at ?? '')),
      JSON.stringify(chatted?.chat?.[0]));

appendChatTurn(GAMMA, `${GAMMA}:gh-login`, { role: 'founder', text: 'I have paid it, try again.' });
const both = readFounderAction(GAMMA, `${GAMMA}:gh-login`);
check('turns keep the order they arrived in',
      both?.chat?.map((turn) => turn.role).join() === 'agent,founder',
      both?.chat?.map((turn) => turn.role).join());
check('a turn against a key nothing holds answers nothing',
      appendChatTurn(GAMMA, `${GAMMA}:push-denied`, { role: 'founder', text: 'hello' }) === null);

check('and the same text in a founder field would have been refused — the two paths are separate',
      validateFounderAction({ ...GOOD, what: TURN_TEXT }).ok === false
      && recordFounderAction({ workspaceId: 'ws-delta', kind: 'gh-login',
                               fields: { ...GOOD, what: TURN_TEXT } }).ok === false,
      'the chat and the card went through the same validator');

// ─── 8. A record outlives the process that noticed it ────────

console.log('\n8. a record outlives the process that noticed it');

const file = founderActionsFile(GAMMA);
check('the workspace has a file of its own under the board state directory',
      typeof file === 'string' && file.startsWith(stateDir), String(file));
check('and it is on disk', typeof file === 'string' && existsSync(file), String(file));

const restarted = await import(`${storeUrl}?restart=1`);
check('a freshly imported instance is a different module',
      restarted.readFounderAction !== readFounderAction);

const survivor = restarted.readFounderAction(GAMMA, `${GAMMA}:gh-login`);
check('it reads the record back', survivor?.key === `${GAMMA}:gh-login`, JSON.stringify(survivor?.key));
check('with its state intact', survivor?.state === 'open', survivor?.state);
check('with its times intact', survivor?.createdAt === elsewhere.record?.createdAt,
      `${elsewhere.record?.createdAt} became ${survivor?.createdAt}`);
check('with its fields intact', survivor?.fields?.title === GOOD.title, survivor?.fields?.title);
check('and with both chat turns intact, the long one byte for byte',
      survivor?.chat?.length === 2 && survivor.chat[0].text === TURN_TEXT,
      `${survivor?.chat?.length} turn(s)`);

const settled = restarted.readFounderAction(ALPHA, `${ALPHA}:gh-login`);
check('a settled record comes back settled, with who settled it',
      settled?.state === 'resolved' && settled?.resolvedBy === 'probe'
      && settled?.resolvedAt === resolved?.resolvedAt,
      JSON.stringify({ state: settled?.state, by: settled?.resolvedBy }));
check('and the workspace comes back with everything it held',
      restarted.listFounderActions(ALPHA).length === 2
      && restarted.openFounderActions(ALPHA).length === 0,
      `${restarted.listFounderActions(ALPHA).length} record(s)`);
check('a workspace nobody ever recorded into is empty rather than broken',
      restarted.listFounderActions('ws-nobody').length === 0);

// ─── 9. A file that is not a document ────────────────────────

console.log('\n9. a truncated, empty or non-JSON file reads as empty, with a warning');

/** A workspace whose file is written by hand, so the load is the thing under test. */
function corrupt(id, contents) {
  writeFileSync(founderActionsFile(id), contents, 'utf8');
  return said(() => listFounderActions(id));
}

/**
 * A whole document to cut in half.
 *
 * The one the store just wrote, so the truncation is of a real file rather than of something
 * this script imagined — and a stand-in when there is no such file, because a store that never
 * wrote one has already failed section 8 and the three cases below still have to be evidence.
 */
const gammaFile = String(founderActionsFile(GAMMA));
const whole = existsSync(gammaFile)
  ? readFileSync(gammaFile, 'utf8')
  : JSON.stringify({ type: 'founder-actions', version: 1, actions: [{ key: `${GAMMA}:gh-login` }] });

const truncated = corrupt('ws-cut', whole.slice(0, Math.floor(whole.length / 2)));
check('a truncated document reads as empty', Array.isArray(truncated.value) && truncated.value.length === 0,
      JSON.stringify(truncated.value));
check('and it says so on the console', /founder action/i.test(truncated.console), truncated.console.trim());

const empty = corrupt('ws-empty', '');
check('an empty file reads as empty', empty.value?.length === 0);
check('and it says so too', /founder action/i.test(empty.console), empty.console.trim());

const rubbish = corrupt('ws-rubbish', 'this was never a document at all\n');
check('a file that was never JSON reads as empty', rubbish.value?.length === 0);
check('and it says so as well', /founder action/i.test(rubbish.console), rubbish.console.trim());

const shaped = corrupt('ws-shaped', JSON.stringify({ type: 'founder-actions', actions: 'not a list' }));
check('a document whose records are not a list reads as empty', shaped.value?.length === 0,
      JSON.stringify(shaped.value));

check('nothing threw on any of them — every read answered',
      [truncated, empty, rubbish, shaped].every((read) => Array.isArray(read.value)));

const repaired = recordFounderAction({ workspaceId: 'ws-cut', kind: 'gh-billing', fields: GOOD });
check('and the next record repairs the file rather than refusing to write', repaired.ok === true);
const afterRepair = await import(`${storeUrl}?repair=1`);
check('a fresh instance reads the repaired file',
      afterRepair.listFounderActions('ws-cut').length === 1,
      `${afterRepair.listFounderActions('ws-cut').length} record(s)`);

// ─── 10. No directory to write to ────────────────────────────

console.log('\n10. with nowhere to write, the store answers from memory and says so');

const hooksPath = join(workDir, 'no-board-state-hooks.mjs');
writeFileSync(hooksPath, `export async function load(target, context, nextLoad) {
  if (target.endsWith('/dist/core/board-state.js')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export function boardStateDir() { return null; }',
    };
  }
  return nextLoad(target, context);
}
`, 'utf8');

/**
 * A child that asks the store to work with no directory behind it.
 *
 * A child rather than another cache-busting import, because the null answer is not reachable
 * through the environment: `boardStateDir()` falls back to a path derived from `registryPath()`,
 * which itself falls back to the per-user state directory. The load hook replaces that one
 * module and leaves every other import alone.
 */
const probePath = join(workDir, 'no-directory-probe.mjs');
writeFileSync(probePath, `import { register } from 'node:module';
register(${url(hooksPath)});

const heard = [];
const real = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, callback) => {
  heard.push(String(chunk));
  const done = typeof encoding === 'function' ? encoding : callback;
  if (typeof done === 'function') done();
  return true;
};

const store = await import(${url(built('founder-store'))});
const fields = ${JSON.stringify(GOOD)};

let threw = null;
let written = null;
let read = null;
let listed = null;
let chat = null;
try {
  written = store.recordFounderAction({ workspaceId: 'ws-nowhere', kind: 'gh-login', fields });
  chat = store.appendChatTurn('ws-nowhere', 'ws-nowhere:gh-login', { role: 'founder', text: 'ok' });
  read = store.readFounderAction('ws-nowhere', 'ws-nowhere:gh-login');
  listed = store.listFounderActions('ws-nowhere').length;
} catch (error) {
  threw = String(error && error.message);
}

process.stderr.write = real;
process.stdout.write(JSON.stringify({
  threw,
  ok: written && written.ok,
  key: read && read.key,
  turns: chat && chat.chat.length,
  listed,
  file: store.founderActionsFile('ws-nowhere'),
  console: heard.join(''),
}));
`, 'utf8');

const probe = await new Promise((resolve) => {
  const child = spawn(process.execPath, [probePath], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => {
    let parsed = null;
    try { parsed = JSON.parse(out); } catch { /* the check below reports the raw output */ }
    resolve({ code, parsed, out, err });
  });
});

check('the child ran at all', probe.code === 0 && probe.parsed !== null,
      `exit ${probe.code}: ${(probe.err || probe.out).slice(0, 400)}`);
check('nothing threw — a board with nowhere to save still starts',
      probe.parsed?.threw === null, String(probe.parsed?.threw));
check('the record was accepted', probe.parsed?.ok === true);
check('and is readable from the memory it degraded to',
      probe.parsed?.key === 'ws-nowhere:gh-login' && probe.parsed?.listed === 1,
      JSON.stringify({ key: probe.parsed?.key, listed: probe.parsed?.listed }));
check('the chat still works there too', probe.parsed?.turns === 1);
check('there is no file to name', probe.parsed?.file === null, String(probe.parsed?.file));
check('and it warned that this board is remembering nothing',
      /founder action/i.test(probe.parsed?.console ?? ''), (probe.parsed?.console ?? '').trim());
check('nothing was written into the state directory by that child',
      !existsSync(join(stateDir, 'ws-nowhere.founder-actions.json')));

// ─── 11. Two hundred records, read on every tick ─────────────

console.log('\n11. two hundred records, parsed by another process on every tick');

const RECORDS = 200;
const BUSY = 'ws-busy';
const busyFile = founderActionsFile(BUSY);
const stopFile = join(workDir, 'stop-reading');

const readerPath = join(workDir, 'tick-reader.mjs');
writeFileSync(readerPath, `import { existsSync, readFileSync } from 'node:fs';

const file = ${JSON.stringify(busyFile)};
const stop = ${JSON.stringify(stopFile)};

let reads = 0;
let found = 0;
let partial = 0;
let most = 0;
const deadline = Date.now() + 60000;

function tick() {
  for (let burst = 0; burst < 40; burst++) {
    reads++;
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      // The file not being there yet is not a partial document; anything else is worth saying.
      if (error.code !== 'ENOENT') partial++;
      continue;
    }
    found++;
    try {
      const document = JSON.parse(raw);
      const actions = Array.isArray(document.actions) ? document.actions : null;
      if (!actions || actions.some((record) => typeof record.key !== 'string')) partial++;
      else most = Math.max(most, actions.length);
    } catch {
      partial++;
    }
  }
  if (existsSync(stop) || Date.now() > deadline) {
    process.stdout.write(JSON.stringify({ reads, found, partial, most }));
    return;
  }
  setImmediate(tick);
}

tick();
`, 'utf8');

const reader = spawn(process.execPath, [readerPath], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
let readerOut = '';
reader.stdout.on('data', (chunk) => { readerOut += chunk; });
const readerDone = new Promise((resolve) => reader.on('close', resolve));

// Let it get to its first read before anything exists, so "never a partial document" is a claim
// about every write rather than about the ones that happened after it woke up.
await sleep(150);

let accepted = 0;
for (let at = 0; at < RECORDS; at++) {
  const written = recordFounderAction({
    workspaceId: BUSY, kind: 'gh-rate-limit', discriminator: `run-${at}`, fields: GOOD,
  });
  if (written.ok) accepted++;
  if (at % 20 === 0) await sleep(1);
}

writeFileSync(stopFile, 'stop', 'utf8');
await readerDone;

let watched = null;
try { watched = JSON.parse(readerOut); } catch { /* reported below */ }

check(`all ${RECORDS} records were accepted`, accepted === RECORDS, `${accepted}`);
check('and all of them are in the workspace', listFounderActions(BUSY).length === RECORDS,
      `${listFounderActions(BUSY).length}`);
check('the reader in the other process ran', watched !== null && watched.reads > 0,
      readerOut.slice(0, 300));
check('it found the file while the writes were going on', (watched?.found ?? 0) > 0,
      `${watched?.found} of ${watched?.reads} reads found a file`);
check('it watched the records arrive', (watched?.most ?? 0) > 1,
      `the most it ever saw in one read was ${watched?.most}`);
check('and it never once saw a partial document', watched?.partial === 0,
      `${watched?.partial} of ${watched?.found} reads`);

check('the file is written in exactly one place in the module',
      (source.match(/writeFileSync\(/g) ?? []).length === 1
      && (source.match(/renameSync\(/g) ?? []).length === 1,
      `${(source.match(/writeFileSync\(/g) ?? []).length} write(s), `
      + `${(source.match(/renameSync\(/g) ?? []).length} rename(s)`);
check('and it lands through a temporary file rather than over the reader\'s',
      /\.tmp/.test(source) && /renameSync/.test(source),
      'a plain write is what a reader sees half of');

// ─── Teardown ────────────────────────────────────────────────
//
// Inside a try/catch: a removal that fails is a Windows file lock in a temporary directory,
// and a green run must not be turned red by one (`scripts/lib/teardown-scan.mjs`).

try { rmSync(workDir, { recursive: true, force: true }); } catch { /* it is a temp directory */ }

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
