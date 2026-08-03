#!/usr/bin/env node
/**
 * Checks the registry of peer boards: the mirror image of `check-device-registry.mjs`.
 *
 * That one holds what a **host** keeps about machines it approved. This holds what a **device**
 * keeps about hosts that approved it — one record per peer board, with the secret to present.
 * The difference between the two files is one word and it decides everything here: the device
 * registry stores a *hash*, because the host only ever has to check one, and this end has to
 * *present* one, so it stores plaintext and the file's permissions are the whole of its defence.
 *
 * Four things cannot be read off the source, and they are what this is for:
 *
 *   - **a reader never sees the file missing, and never sees half of it.** A peer registry is
 *     *updated* — a peer is renamed, a peer is forgotten — where the token file is written once
 *     per start. Copying `writeAuthToken` literally would leave a window between the unlink and
 *     the create in which a concurrent reader finds nothing at all; a plain `writeFileSync` onto
 *     the target would leave a window in which it finds a truncated body. Those are two different
 *     failures and a check that only tests for one of them passes against the other, so section 6
 *     runs a reader in another process, in a tight loop, while this one renames and forgets, and
 *     counts both.
 *   - **the permissions on the file.** Owner-only, and *re*-owner-only after somebody has widened
 *     them by hand. POSIX-only, and said out loud as skipped rather than passed on win32, the way
 *     `check-token-auth.mjs` already does it: `statSync().mode` there reports a synthesised
 *     `0o666` whatever the ACL says, so an assertion would be about Node's fiction.
 *   - **add, restart, list.** Two module loads that share a state directory and nothing else,
 *     which is what a restart is.
 *   - **the secret is in nothing this module says.** Not in a log line, not in a refusal handed
 *     back to a caller. A file that holds plaintext must not also be a thing that quotes it.
 *
 * Offline and self-contained: a throwaway state home under the system temp directory, a couple of
 * short-lived `node` children, no server and no browser. It reads the compiled module, so run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-peer-registry.mjs
 *
 * Tier: fast
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The throwaway world ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-peer-registry-'));
/** The parent of the state directory, which is what `EXCALIDRAW_STATE_HOME` names. */
const stateHome = join(workDir, 'state');
const logFile = join(workDir, 'canvas.log');
mkdirSync(stateHome, { recursive: true });

/**
 * The environment every process here gets, this one included.
 *
 * `NO_DOTENV` because a file layer only ever supplies variables a caller deliberately left unset,
 * and on this machine that means the operator's real `config.json` — including a real
 * `STATE_HOME` — landing on top of the throwaway one below. `LOG_FILE_PATH`, because the console
 * transport is warn-and-above and the "this file is malformed" line has to be read back from
 * somewhere.
 */
const childEnv = {
  ...process.env,
  EXCALIDRAW_NO_DOTENV: '1',
  VIBEMAXXING_NO_DOTENV: '1',
  EXCALIDRAW_STATE_HOME: stateHome,
  VIBEMAXXING_STATE_HOME: stateHome,
  LOG_FILE_PATH: logFile,
  LOG_LEVEL: 'info',
};
for (const [name, value] of Object.entries(childEnv)) process.env[name] = value;

const modulePath = join(repoRoot, 'dist', 'core', 'peer-registry.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the peer registry exists — dist/core/peer-registry.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const peers = await import(pathToFileURL(modulePath).href);
const {
  addPeer, getPeer, listPeers, renamePeer, forgetPeer, touchPeer, peerRegistryPath,
} = peers;

let childSteps = 0;

/** A child process that shares this run's state directory and nothing else. */
function inAnotherProcess(source) {
  const file = join(workDir, `step-${childSteps++}.mjs`);
  writeFileSync(file, source, 'utf8');
  return execFileSync(process.execPath, [file], { env: childEnv, encoding: 'utf8' }).trim();
}

const moduleUrl = pathToFileURL(modulePath).href;
const preamble = `import * as peers from ${JSON.stringify(moduleUrl)};\n`;

/** A secret of the shape the other machine mints: 32 bytes of hex. */
const DESKTOP_SECRET = 'a1'.repeat(32);
const PHONE_SECRET = 'b2'.repeat(32);

// ─── 1. A peer is added, and the record is what a link needs ──

console.log('1. a peer is added, and the record carries what it takes to reach that board again');

const desktop = addPeer({
  id: 'e30ac1f2b4d5',
  name: 'Desktop',
  baseUrl: 'http://desktop.tailnet.ts.net:3737',
  secret: DESKTOP_SECRET,
});
check('adding one is accepted', desktop?.ok === true, JSON.stringify(desktop));
check('and answers with the record it wrote', desktop?.peer?.id === 'e30ac1f2b4d5',
      JSON.stringify(desktop?.peer));

const listed = listPeers();
check('it is the one peer listed', listed.length === 1 && listed[0]?.id === 'e30ac1f2b4d5',
      JSON.stringify(listed.map((peer) => peer?.id)));
check('under the name it was added with', listed[0]?.name === 'Desktop', listed[0]?.name);
check('with the address that board answers on', listed[0]?.baseUrl === 'http://desktop.tailnet.ts.net:3737',
      listed[0]?.baseUrl);
check('added at an ISO instant', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(listed[0]?.addedAt ?? ''),
      listed[0]?.addedAt);
check('and never seen yet, which is a state and not a missing field',
      listed[0]?.lastSeenAt === null, JSON.stringify(listed[0]?.lastSeenAt));

check('getting it by id answers the same record', getPeer('e30ac1f2b4d5')?.id === 'e30ac1f2b4d5',
      JSON.stringify(getPeer('e30ac1f2b4d5')));
check('and an id nothing knows answers null rather than throwing',
      getPeer('00000000dead') === null);
for (const nonsense of ['', null, undefined, 42, {}]) {
  check(`nonsense asked for is null rather than thrown on — ${JSON.stringify(nonsense)}`,
        getPeer(nonsense) === null);
}

// This end holds the secret rather than a hash, because it has to *present* one. That is the
// whole difference from `devices.json` and it is what makes the permissions section load-bearing.
check('the record carries the secret this board presents, not a hash of it',
      getPeer('e30ac1f2b4d5')?.secret === DESKTOP_SECRET);

const registryFile = peerRegistryPath();
check('the registry is a file in the state directory', existsSync(registryFile), registryFile);
check('and it is beside the state directory rather than in this repository',
      registryFile.startsWith(stateHome), registryFile);
check('the secret is in it, in plaintext, because this end presents one',
      readFileSync(registryFile, 'utf8').includes(DESKTOP_SECRET));

// ─── 2. The address is normalised and validated on the way in ─

console.log('\n2. a baseUrl is normalised and validated on the way in');

let spare = 0;
/** Add a peer nothing else in this run cares about, and answer what came back. */
const addWith = (baseUrl) => addPeer({
  id: `spare${spare++}`, name: 'Spare', baseUrl, secret: PHONE_SECRET,
});

const normalised = [
  ['http://board.example:3737', 'http://board.example:3737'],
  ['http://board.example:3737/', 'http://board.example:3737'],
  ['  http://board.example:3738  ', 'http://board.example:3738'],
  ['http://BOARD.Example:3739', 'http://board.example:3739'],
  ['HTTP://board.example:3740', 'http://board.example:3740'],
  ['https://board.example', 'https://board.example'],
  ['http://board.example:80', 'http://board.example'],
  ['https://board.example:443', 'https://board.example'],
  ['http://127.0.0.1:3737', 'http://127.0.0.1:3737'],
  ['http://[::1]:3737', 'http://[::1]:3737'],
];
for (const [given, wanted] of normalised) {
  const added = addWith(given);
  check(`${JSON.stringify(given)} is stored as ${wanted}`,
        added?.ok === true && added.peer.baseUrl === wanted,
        added?.ok ? added.peer.baseUrl : added?.error);
}

/**
 * Every one of these is a stored entry that would later be concatenated into a request going
 * somewhere other than where the operator thought they approved.
 *
 * The path, query and fragment cases are the point of the rule rather than tidiness: a peer
 * whose `baseUrl` ends in `/api/x` turns `${baseUrl}/api/workspaces` into a path nobody wrote,
 * and one carrying `?` or `#` swallows whatever is appended to it entirely. The backslash case
 * is the same trap spelled the way a browser reads it — WHATWG parsing turns `\` into `/` for an
 * http URL, so the authority is `good.example` and the rest is a path.
 */
const refused = [
  ['', 'nothing at all'],
  ['   ', 'blank'],
  ['not a url', 'not a URL'],
  ['board.example:3737', 'no scheme'],
  ['//board.example:3737', 'no scheme'],
  ['ftp://board.example', 'a scheme that is not http'],
  ['file:///etc/passwd', 'a scheme that is not http'],
  ['ws://board.example:3737', 'a scheme that is not http'],
  ['http://', 'no host'],
  ['http://user:secret@board.example', 'credentials in the address'],
  ['http://board.example/api', 'a path'],
  ['http://board.example/?workspace=x', 'a query'],
  ['http://board.example/#somewhere', 'a fragment'],
  ['http://board.example:0', 'port zero'],
  ['http://board.example:99999', 'a port out of range'],
  ['http://good.example\\@evil.example/', 'an authority that is not the one it reads as'],
];
for (const [given, why] of refused) {
  const added = addWith(given);
  check(`${JSON.stringify(given)} is refused — ${why}`, added?.ok === false,
        added?.ok ? `stored as ${added.peer.baseUrl}` : '');
  check(`  and the refusal says what was wrong rather than nothing`,
        added?.ok === false && typeof added.error === 'string' && added.error.length > 10,
        JSON.stringify(added?.error));
  check('  and never quotes the secret it was handed',
        added?.ok === false && !added.error.includes(PHONE_SECRET), 'the refusal carries the secret');
}

const before = listPeers().length;
check('a refused peer is not on the list', listPeers().every((peer) => peer.baseUrl !== 'not a url'));

// ─── 3. Two peers cannot share an id ──────────────────────────

console.log('\n3. two peers cannot share an id, and the refusal says which entry holds it');

const clash = addPeer({
  id: 'e30ac1f2b4d5', name: 'Something else', baseUrl: 'http://other.example:3737',
  secret: PHONE_SECRET,
});
check('a second peer under an id already taken is refused', clash?.ok === false,
      JSON.stringify(clash));
check('and the refusal names the id', clash?.ok === false && clash.error.includes('e30ac1f2b4d5'),
      clash?.error);
check('and names the entry that already holds it',
      clash?.ok === false && clash.error.includes('Desktop'), clash?.error);
check('the refusal carries neither secret',
      clash?.ok === false && !clash.error.includes(PHONE_SECRET) && !clash.error.includes(DESKTOP_SECRET),
      'a refusal is a thing that gets logged and pasted into an issue');
check('nothing was written — the peer that was there is untouched',
      getPeer('e30ac1f2b4d5')?.name === 'Desktop' && listPeers().length === before,
      JSON.stringify(getPeer('e30ac1f2b4d5')?.name));

for (const bad of [
  { id: '', name: 'No id', baseUrl: 'http://board.example:3737', secret: PHONE_SECRET },
  { id: 'no-secret', name: 'No secret', baseUrl: 'http://board.example:3737', secret: '' },
  { id: 'no-secret', name: 'No secret', baseUrl: 'http://board.example:3737' },
  null,
]) {
  const added = addPeer(bad);
  check(`a record missing what a link needs is refused — ${JSON.stringify(bad)}`,
        added?.ok === false, JSON.stringify(added));
}

// ─── 4. Add, restart, list ────────────────────────────────────

console.log('\n4. a peer added by one process is there for the next');

// The whole point of the file, and the one thing memory cannot do. Two processes that share the
// state directory and nothing else: no memory, no handover, no port.
const added = JSON.parse(inAnotherProcess(`${preamble}
const result = peers.addPeer({
  id: 'c0ffee001122', name: 'Studio', baseUrl: 'https://studio.tailnet.ts.net', secret: ${JSON.stringify(PHONE_SECRET)},
});
console.log(JSON.stringify({ ok: result.ok, id: result.ok ? result.peer.id : null, error: result.error ?? null }));
`));
check('another process adds one', added.ok === true && added.id === 'c0ffee001122',
      JSON.stringify(added));

const readBack = JSON.parse(inAnotherProcess(`${preamble}
const found = peers.getPeer('c0ffee001122');
console.log(JSON.stringify({
  name: found ? found.name : null,
  baseUrl: found ? found.baseUrl : null,
  secret: found ? found.secret : null,
  count: peers.listPeers().length,
}));
`));
check('a third process, sharing only the file, reads it back', readBack.name === 'Studio',
      JSON.stringify(readBack));
check('with the address it was added under', readBack.baseUrl === 'https://studio.tailnet.ts.net',
      readBack.baseUrl);
check('and the secret it has to present', readBack.secret === PHONE_SECRET);
check('this process, which never added it, sees it too', getPeer('c0ffee001122')?.name === 'Studio');

const forgotten = inAnotherProcess(`${preamble}
console.log(JSON.stringify(peers.forgetPeer('c0ffee001122')));
`);
check('another process forgets it', forgotten === 'true', forgotten);
// No restart, no re-import, no cache to invalidate: the next call is the next request.
check('and this long-lived process sees it gone on the very next call',
      getPeer('c0ffee001122') === null,
      'the registry is being cached in memory — a forget would wait for a restart');

// ─── 5. Rename, forget, touch ─────────────────────────────────

console.log('\n5. a peer can be renamed, forgotten, and told when it was last seen');

check('renaming answers true', renamePeer('e30ac1f2b4d5', 'Desk downstairs') === true);
const renamed = getPeer('e30ac1f2b4d5');
check('and the new name is what is stored', renamed?.name === 'Desk downstairs', renamed?.name);
check('the secret is untouched by a rename', renamed?.secret === DESKTOP_SECRET);
check('as is the address, and when it was added',
      renamed?.baseUrl === 'http://desktop.tailnet.ts.net:3737' && renamed?.addedAt === listed[0].addedAt);
check('renaming one nothing knows about says so', renamePeer('00000000dead', 'Ghost') === false);
check('renaming to nothing at all is refused rather than stored',
      renamePeer('e30ac1f2b4d5', '   ') === false && getPeer('e30ac1f2b4d5')?.name === 'Desk downstairs');

check('touching one answers true', touchPeer('e30ac1f2b4d5') === true);
const seen = getPeer('e30ac1f2b4d5')?.lastSeenAt;
check('and it now carries an ISO instant', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(seen ?? ''), seen);
await sleep(5);
check('touching it again moves it forward', touchPeer('e30ac1f2b4d5') === true);
const seenAgain = getPeer('e30ac1f2b4d5')?.lastSeenAt;
check('to a later instant', Date.parse(seenAgain) > Date.parse(seen), `${seen} → ${seenAgain}`);
check('touching one nothing knows about says so', touchPeer('00000000dead') === false);

const throwaway = addPeer({
  id: 'f0f0f0f0f0f0', name: 'Throwaway', baseUrl: 'http://throwaway.example:3737', secret: PHONE_SECRET,
});
check('a peer added to be forgotten is there first', throwaway?.ok === true);
check('forgetting it answers true', forgetPeer('f0f0f0f0f0f0') === true);
check('and it is off the list', getPeer('f0f0f0f0f0f0') === null);
check('forgetting one twice says so rather than throwing', forgetPeer('f0f0f0f0f0f0') === false);
check('and forgetting one nothing knows about says so', forgetPeer('00000000dead') === false);
check('while the peer that was not forgotten is still there',
      getPeer('e30ac1f2b4d5')?.name === 'Desk downstairs');

// ─── 6. A reader never sees it missing, and never sees half ───

console.log('\n6. a reader looking at the file while it is updated never sees it missing or half-written');

/**
 * The section the whole file is shaped around, and the two failures it separates.
 *
 * `writeAuthToken` copied literally — unlink the target, then create it — is correct for a
 * secret written once per start and wrong for a registry that is *updated*: between the unlink
 * and the create the file is not there, and a reader in that window gets `ENOENT`.
 *
 * A plain `writeFileSync` onto the target closes that window and opens another: `w` truncates,
 * so a reader in *that* window gets an empty or partial body and a `JSON.parse` that throws.
 *
 * They are different failures with the same symptom for whoever is reading, so both are counted
 * here. A check that asserted only "never missing" would pass against the second draft and a
 * check that asserted only "always parses" would pass against neither reliably — the truncation
 * is what makes the second one observable at all.
 *
 * The reader is another process because the writes here are synchronous: nothing in *this*
 * process can be interleaved with a `writeFileSync` by construction, so a loop here would be
 * asserting a tautology.
 */
const stopFile = join(workDir, 'reader-stop');
const readyFile = join(workDir, 'reader-ready');
const readerFile = join(workDir, 'reader.mjs');
writeFileSync(readerFile, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [file, ready, stop, until] = process.argv.slice(2);
const deadline = Number(until);
const seen = { reads: 0, missing: 0, unparsable: 0, shapeless: 0, smallest: -1, worst: null };
const note = (what) => { if (!seen.worst) seen.worst = what; };

writeFileSync(ready, 'ready', 'utf8');

while (!existsSync(stop) && Date.now() < deadline) {
  seen.reads++;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    seen.missing++;
    note(\`\${error.code} — the file was not there at all\`);
    continue;
  }
  if (seen.smallest < 0 || raw.length < seen.smallest) seen.smallest = raw.length;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    seen.unparsable++;
    note(\`\${raw.length} bytes that do not parse: \${error.message}\`);
    continue;
  }
  if (!parsed || !Array.isArray(parsed.peers)) {
    seen.shapeless++;
    note(\`\${raw.length} bytes with no peers array\`);
  }
}

console.log(JSON.stringify(seen));
`, 'utf8');

// Enough peers that the body is tens of kilobytes: the wider the file, the wider the window a
// truncating write leaves open, and the less this depends on how one platform buffers a write.
const CROWD = 150;
for (let n = 0; n < CROWD; n++) {
  addPeer({
    id: `crowd${String(n).padStart(4, '0')}`,
    name: `Peer number ${n} on somebody's desk`,
    baseUrl: `http://peer-${n}.tailnet.ts.net:3737`,
    secret: PHONE_SECRET,
  });
}
const crowded = readFileSync(registryFile, 'utf8').length;
check(`the registry is large enough for a partial write to be visible — ${crowded} bytes`,
      crowded > 10000, `${crowded} bytes`);

const reader = spawn(process.execPath,
                     [readerFile, registryFile, readyFile, stopFile, String(Date.now() + 60000)],
                     { env: childEnv });
let readerOut = '';
let readerErr = '';
reader.stdout.on('data', (chunk) => { readerOut += chunk; });
reader.stderr.on('data', (chunk) => { readerErr += chunk; });

for (let attempt = 0; attempt < 400 && !existsSync(readyFile); attempt++) await sleep(10);
check('the reader in the other process started', existsSync(readyFile), readerErr.slice(0, 400));

// Renames and forgets, which are the two updates a person performs on this file, in a burst.
// Synchronous on purpose: this process is blocked for the whole burst and the reader is not.
let updates = 0;
for (let n = 0; n < CROWD; n++) {
  const id = `crowd${String(n).padStart(4, '0')}`;
  if (renamePeer(id, `Renamed peer ${n}`)) updates++;
  if (n % 3 === 0 && forgetPeer(id)) updates++;
}
writeFileSync(stopFile, 'stop', 'utf8');
await new Promise((resolve) => reader.on('close', resolve));

const watched = JSON.parse(readerOut.trim() || '{}');
check(`the updates and the reads overlapped — ${updates} writes, ${watched.reads ?? 0} reads`,
      updates > 100 && (watched.reads ?? 0) > 50,
      `${updates} writes against ${watched.reads ?? 0} reads: ${readerErr.slice(0, 400)}`);
check('the reader never found the file missing',
      watched.missing === 0,
      `${watched.missing} of ${watched.reads} reads: ${watched.worst}`);
check('the reader never found a body it could not parse',
      watched.unparsable === 0,
      `${watched.unparsable} of ${watched.reads} reads: ${watched.worst}`);
check('and never one that parsed into something that is not a registry',
      watched.shapeless === 0,
      `${watched.shapeless} of ${watched.reads} reads: ${watched.worst}`);
check('every read it took was of a whole file',
      watched.smallest > 1000,
      `the smallest body it saw was ${watched.smallest} bytes`);

for (let n = 0; n < CROWD; n++) forgetPeer(`crowd${String(n).padStart(4, '0')}`);
check('the peers that were there before the burst survived it',
      getPeer('e30ac1f2b4d5')?.name === 'Desk downstairs'
      && getPeer('e30ac1f2b4d5')?.secret === DESKTOP_SECRET);

// ─── 7. The file is the operator's own ────────────────────────

console.log('\n7. the file is owner-only, and stays owner-only after somebody widens it');

if (process.platform === 'win32') {
  // Windows has no POSIX mode bits — `statSync().mode` reports a synthesised `0o666`/`0o444` from
  // the read-only attribute and `chmod` there is close to a no-op. The file is protected by the
  // ACL on `%LOCALAPPDATA%` instead, which is the same defence the token file has. Said as
  // skipped rather than passed, so a run on this platform is not read as evidence about a mode.
  console.log('  ..    the mode cases are POSIX-only; this platform has no mode bits to read');
} else {
  const mode = statSync(registryFile).mode & 0o777;
  check('its permissions deny group and other', (mode & 0o077) === 0, `mode ${mode.toString(8)}`);
  check('and grant the owner read and write', (mode & 0o600) === 0o600, `mode ${mode.toString(8)}`);

  // The load-bearing half, and the reason a create mode is not enough on its own: `mode` on
  // `writeFileSync` applies only when a file is *created*, so an update that wrote over one
  // somebody had widened by hand would keep the widened permissions — and this file is plaintext.
  chmodSync(registryFile, 0o666);
  check('a widened file is widened', (statSync(registryFile).mode & 0o077) !== 0);

  renamePeer('e30ac1f2b4d5', 'Desk downstairs again');
  const after = statSync(registryFile).mode & 0o777;
  check('one update later it is owner-only again', (after & 0o077) === 0, `mode ${after.toString(8)}`);
  check('and the rename it was doing at the time landed',
        getPeer('e30ac1f2b4d5')?.name === 'Desk downstairs again');
}

// ─── 8. A hand-edited file is "no peers", said out loud ───────

console.log('\n8. a malformed registry reads as no peers, and says which file it was');

const rescue = readFileSync(registryFile, 'utf8');
writeFileSync(registryFile, '{ this is what an editor leaves behind', 'utf8');

let threw = null;
let peersBack = null;
try { peersBack = listPeers(); } catch (error) { threw = error; }
check('reading it does not throw', threw === null, threw?.message);
check('it reads as no peers at all', Array.isArray(peersBack) && peersBack.length === 0,
      JSON.stringify(peersBack));
check('and nothing is found in it', getPeer('e30ac1f2b4d5') === null);
check('a read leaves the file alone rather than replacing what it could not parse',
      readFileSync(registryFile, 'utf8') === '{ this is what an editor leaves behind',
      'the operator has to be able to fix it by hand');

// The log file is where a board's own account of a start goes; the console transport is
// warn-and-above, so this is the surface a reader has for a file that was ignored.
let logged = '';
for (let attempt = 0; attempt < 40 && !logged.includes(registryFile); attempt++) {
  await sleep(50);
  try { logged = readFileSync(logFile, 'utf8'); } catch { /* not written yet */ }
}
check('the log says which file was ignored', logged.includes(registryFile),
      logged.split('\n').filter(Boolean).slice(-3).join(' | ') || '(the log file is empty)');

writeFileSync(registryFile, JSON.stringify({ peers: 'not an array' }), 'utf8');
check('a file of the wrong shape reads as no peers too', listPeers().length === 0);

writeFileSync(registryFile, JSON.stringify({
  version: 1,
  peers: [
    { id: 'good', name: 'Kept', baseUrl: 'http://kept.example:3737', secret: PHONE_SECRET,
      addedAt: '2026-08-03T10:00:00.000Z', lastSeenAt: null },
    { id: 'no-secret', name: 'Dropped', baseUrl: 'http://dropped.example:3737' },
    { id: 'no-url', name: 'Dropped', secret: PHONE_SECRET },
    { name: 'No id at all', baseUrl: 'http://nameless.example:3737', secret: PHONE_SECRET },
    'not even an object',
  ],
}), 'utf8');
const survivors = listPeers();
check('a record with no secret, no address or no id is dropped and the rest are kept',
      survivors.length === 1 && survivors[0].id === 'good',
      JSON.stringify(survivors.map((peer) => peer.id)));

writeFileSync(registryFile, rescue, 'utf8');
check('and the real registry reads back once it is put right',
      getPeer('e30ac1f2b4d5')?.secret === DESKTOP_SECRET,
      JSON.stringify(listPeers().map((peer) => peer.name)));

// ─── 9. The secret is in nothing it says, and one module owns the file ──

console.log('\n9. the secret is in nothing this module says, and one module owns the file');

check('nothing the run logged carries a secret',
      !logged.includes(DESKTOP_SECRET) && !logged.includes(PHONE_SECRET),
      'a plaintext secret in a log file is the file permissions undone');

// Re-read rather than reusing the poll above: the burst in section 6 and everything after it
// have written since, and a log line naming a secret would most likely come from one of those.
let wholeLog = '';
try { wholeLog = readFileSync(logFile, 'utf8'); } catch { /* nothing was logged at all */ }
check('nor anything logged after it', !wholeLog.includes(DESKTOP_SECRET) && !wholeLog.includes(PHONE_SECRET),
      wholeLog.split('\n').filter((line) => line.includes(DESKTOP_SECRET) || line.includes(PHONE_SECRET))
        .slice(0, 2).join(' | '));

const source = readFileSync(join(repoRoot, 'src', 'core', 'peer-registry.ts'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const quoting = code.split('\n')
  .filter((line) => /\b(logger|Error|error:)\b/.test(line) && /\bsecret\b/.test(line))
  .map((line) => line.trim());
check('and no line in the module puts a secret into a log call or a refusal',
      quoting.length === 0, quoting.join(' | '));

const fileName = registryFile.split(/[\\/]/).pop();

/** Every source file under a directory. A walk rather than `git ls-files`: a check that shells
 *  out to git is a check that dies in a checkout git cannot read, and this rule is about what
 *  the source says rather than about what is tracked. */
function sourcesUnder(relative) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) found.push(full);
    }
  };
  walk(join(repoRoot, relative));
  return found;
}

const otherReaders = [...sourcesUnder('src'), ...sourcesUnder(join('frontend', 'src'))]
  .filter((file) => !file.endsWith(`core${sep}peer-registry.ts`))
  .filter((file) => readFileSync(file, 'utf8').includes(fileName))
  .map((file) => file.slice(repoRoot.length + 1));
check(`nothing else names ${fileName}`, otherReaders.length === 0, otherReaders.join(', '));

for (const name of ['addPeer', 'getPeer', 'listPeers', 'renamePeer', 'forgetPeer', 'touchPeer',
                    'peerRegistryPath']) {
  check(`the module owns ${name}`, typeof peers[name] === 'function');
}

// ─── Done ─────────────────────────────────────────────────────

rmSync(workDir, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
