#!/usr/bin/env node
/**
 * Checks the registry of paired devices: that it survives a restart, that a revocation bites
 * the next request rather than the next start, and that the file it keeps is the operator's own.
 *
 * The only credential this server had was `AUTH_TOKEN` — one secret, generated at startup,
 * written beside the pidfile. That is the right shape for one operator on one machine and the
 * wrong shape for a second device twice over: it is per start, so a paired device loses access
 * every time somebody presses **Restart** on the bar, and it is *one* secret, so there is
 * nothing to revoke short of restarting and no way to answer "which devices can drive this
 * board". `core/device-registry.ts` is the answer to both, and this is what holds it to them.
 *
 * Four of these cases are named in #502 and are the ones that cannot be read off the source:
 *
 *   - **verify after a restart.** A process that shares nothing with the one that paired the
 *     device — no memory, no handover file — still admits it. Two child processes with the same
 *     state directory and nothing else, which is exactly what a restart is.
 *   - **revoke takes effect immediately.** A process that has already verified a credential
 *     refuses it on the *next* call after another process revoked it. The registry is therefore
 *     not allowed to be cached in memory, and that is a thing a check can prove and a reader
 *     cannot.
 *   - **the constant-time compare is used.** A secret compared with `===` leaks how far a guess
 *     agreed through the time it took to say no, and the difference does not show up in any
 *     behaviour. So the module's own source is read: `timingSafeEqual`, and no `===` anywhere
 *     near a hash.
 *   - **the permissions on the file.** Owner-only, and *re-*owner-only after somebody has
 *     widened them by hand — which is what unlinking before writing is for, since `mode` on
 *     `writeFileSync` applies only when the file is created.
 *
 * And the rule that the whole feature rests on: the file holds a **hash**, never the secret.
 * The token file has to hold plaintext, because being readable is its handover mechanism; this
 * one never does, so a readable registry is not a set of credentials.
 *
 * Offline and self-contained: a throwaway state directory under the system temp directory, a
 * couple of short-lived `node` children, no server, no network. It reads the compiled module,
 * so run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-device-registry.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync
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

const workDir = mkdtempSync(join(tmpdir(), 'check-device-registry-'));
/** The parent of the state directory, which is what `EXCALIDRAW_STATE_HOME` names. */
const stateHome = join(workDir, 'state');
const logFile = join(workDir, 'canvas.log');
mkdirSync(stateHome, { recursive: true });

/**
 * The environment every process here gets, this one included.
 *
 * `NO_DOTENV` because a file layer only ever supplies variables a caller deliberately left
 * unset, and on this machine that means the operator's real `config.json` — including a real
 * `STATE_HOME` — landing on top of the throwaway one below. `LOG_FILE_PATH`, because the
 * console transport is warn-and-above and the "this file is malformed" line has to be read back
 * from somewhere.
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

const modulePath = join(repoRoot, 'dist', 'core', 'device-registry.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the device registry exists — dist/core/device-registry.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

const registry = await import(pathToFileURL(modulePath).href);
const {
  addDevice, listDevices, verifyDevice, touchDevice, renameDevice, revokeDevice,
  deviceCredential, deviceRegistryPath,
} = registry;

let childSteps = 0;

/** A child process that shares this run's state directory and nothing else. */
function inAnotherProcess(source) {
  const file = join(workDir, `step-${childSteps++}.mjs`);
  writeFileSync(file, source, 'utf8');
  return execFileSync(process.execPath, [file], { env: childEnv, encoding: 'utf8' }).trim();
}

const moduleUrl = pathToFileURL(modulePath).href;
const preamble = `import * as registry from ${JSON.stringify(moduleUrl)};\n`;

// ─── 1. A device is added, and what lands on disk is a hash ───

console.log('1. a device is added, and the file holds a hash rather than the secret');

const laptop = addDevice({ name: 'Laptop', host: 'board.tail-scale.ts.net:3737', approvedFrom: '127.0.0.1' });
check('adding one answers with a record and a secret',
      Boolean(laptop?.device?.id) && typeof laptop?.secret === 'string' && laptop.secret.length >= 32,
      JSON.stringify(laptop));

const listed = listDevices();
check('and it is the one device listed', listed.length === 1 && listed[0].id === laptop.device.id,
      JSON.stringify(listed));
check('carrying the name it was approved under', listed[0]?.name === 'Laptop', listed[0]?.name);
check('the authority it was approved for',
      listed[0]?.host === 'board.tail-scale.ts.net:3737', listed[0]?.host);
check('and where the approval was made from', listed[0]?.approvedFrom === '127.0.0.1',
      listed[0]?.approvedFrom);
check('created at an ISO instant', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(listed[0]?.createdAt ?? ''),
      listed[0]?.createdAt);
check('and never seen yet, which is a state and not a missing field',
      listed[0]?.lastSeenAt === null, JSON.stringify(listed[0]?.lastSeenAt));

const registryFile = deviceRegistryPath();
check('the registry is a file in the state directory', existsSync(registryFile), registryFile);

const onDisk = readFileSync(registryFile, 'utf8');
check('the secret is not in it', !onDisk.includes(laptop.secret),
      'the device holds the secret; the server only ever verifies one');
check('a hash of it is', onDisk.includes(listed[0]?.secretHash ?? 'no hash on the record'), 'no secretHash on the record');
check('and the hash is not the secret under another name',
      listed[0]?.secretHash !== laptop.secret && (listed[0]?.secretHash ?? '').length >= 32,
      listed[0]?.secretHash);

// ─── 2. Verifying ─────────────────────────────────────────────

console.log('\n2. only the credential that was issued verifies');

const laptopCredential = deviceCredential(laptop.device.id, laptop.secret);
check('the credential it was issued verifies',
      verifyDevice(laptopCredential)?.id === laptop.device.id, JSON.stringify(verifyDevice(laptopCredential)));

const phone = addDevice({ name: 'Phone', host: 'board.tail-scale.ts.net:3737', approvedFrom: '127.0.0.1' });
const phoneCredential = deviceCredential(phone.device.id, phone.secret);
check('a second device gets its own', phone.secret !== laptop.secret && phone.device.id !== laptop.device.id);
check('which verifies as itself and not as the first',
      verifyDevice(phoneCredential)?.id === phone.device.id);

check('a wrong secret against a real id is refused',
      verifyDevice(deviceCredential(laptop.device.id, phone.secret)) === null);
check('a real secret against an id nothing knows is refused',
      verifyDevice(deviceCredential('00000000deadbeef', laptop.secret)) === null);
check('a secret one character short is refused',
      verifyDevice(deviceCredential(laptop.device.id, laptop.secret.slice(0, -1))) === null);
check('a secret one character long is refused',
      verifyDevice(deviceCredential(laptop.device.id, `${laptop.secret}0`)) === null);
for (const nonsense of ['', 'no-separator', '.', 'x.y', null, undefined]) {
  check(`nonsense is refused rather than thrown on — ${JSON.stringify(nonsense)}`,
        verifyDevice(nonsense) === null);
}

// ─── 3. It survives a restart ─────────────────────────────────

console.log('\n3. a device paired by one process is admitted by the next');

// The whole point of the feature, and the one thing the token file cannot do. Two processes
// that share the state directory and nothing else: no memory, no handover, no port.
const paired = JSON.parse(inAnotherProcess(`${preamble}
const added = registry.addDevice({ name: 'Desktop', host: 'board:3737', approvedFrom: '127.0.0.1' });
console.log(JSON.stringify({
  id: added.device.id,
  credential: registry.deviceCredential(added.device.id, added.secret),
}));
`));

const admitted = JSON.parse(inAnotherProcess(`${preamble}
const found = registry.verifyDevice(${JSON.stringify(paired.credential)});
console.log(JSON.stringify({ id: found ? found.id : null, count: registry.listDevices().length }));
`));
check('a third process, sharing only the file, admits it', admitted.id === paired.id,
      JSON.stringify(admitted));
check('and sees all three devices', admitted.count === 3, JSON.stringify(admitted));
check('this process, which never paired it, admits it too',
      verifyDevice(paired.credential)?.id === paired.id);

// ─── 4. Revoking bites the next request ───────────────────────

console.log('\n4. a revoked device is refused on the next request, not the next restart');

check('the phone verifies before it is revoked', verifyDevice(phoneCredential)?.id === phone.device.id);

const revoked = inAnotherProcess(`${preamble}
console.log(JSON.stringify(registry.revokeDevice(${JSON.stringify(phone.device.id)})));
`);
check('another process revokes it', revoked === 'true', revoked);

// No restart, no re-import, no cache to invalidate: the next call is the next request.
check('and this long-lived process refuses it on the very next call',
      verifyDevice(phoneCredential) === null,
      'the registry is being cached in memory — a revocation would wait for a restart');
check('it is off the list too',
      listDevices().every((device) => device.id !== phone.device.id),
      JSON.stringify(listDevices().map((device) => device.name)));
check('while the others still verify', verifyDevice(laptopCredential)?.id === laptop.device.id);
check('revoking one twice says so rather than throwing', revokeDevice(phone.device.id) === false);
check('and revoking one nothing knows about says so', revokeDevice('00000000deadbeef') === false);

// ─── 5. Renaming and last seen ────────────────────────────────

console.log('\n5. a device can be renamed, and says when it was last seen');

check('renaming answers true', renameDevice(laptop.device.id, 'Work laptop') === true);
const renamed = listDevices().find((device) => device.id === laptop.device.id);
check('and the new name is what is listed', renamed?.name === 'Work laptop', renamed?.name);
check('the secret is untouched by a rename',
      verifyDevice(laptopCredential)?.id === laptop.device.id);
check('as is when it was created', renamed?.createdAt === listed[0].createdAt);
check('renaming one nothing knows about says so', renameDevice('00000000deadbeef', 'Ghost') === false);

check('touching one answers true', touchDevice(laptop.device.id) === true);
const seen = listDevices().find((device) => device.id === laptop.device.id)?.lastSeenAt;
check('and it now carries an ISO instant', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(seen ?? ''), seen);

await sleep(5);
check('touching it again moves it forward', touchDevice(laptop.device.id) === true);
const seenAgain = listDevices().find((device) => device.id === laptop.device.id)?.lastSeenAt;
check('to a later instant', Date.parse(seenAgain) > Date.parse(seen), `${seen} → ${seenAgain}`);

const seenElsewhere = inAnotherProcess(`${preamble}
const found = registry.listDevices().find((device) => device.id === ${JSON.stringify(laptop.device.id)});
console.log(JSON.stringify(found ? found.lastSeenAt : null));
`);
check('and the next process reads it back', JSON.parse(seenElsewhere) === seenAgain, seenElsewhere);
check('touching one nothing knows about says so', touchDevice('00000000deadbeef') === false);

// ─── 6. The file is the operator's own ────────────────────────

console.log('\n6. the file is written the way the token file is: owner-only, unlinked first');

if (process.platform === 'win32') {
  // Windows has no POSIX mode bits — `statSync().mode` reports a synthesised `0o666`/`0o444`
  // from the read-only attribute and `chmod` is close to a no-op there. The file is protected
  // by the ACL on `%LOCALAPPDATA%` instead, which is the same defence the token file has.
  console.log('  ..    the mode cases are POSIX-only; this platform has no mode bits to read');
} else {
  const mode = statSync(registryFile).mode & 0o777;
  check('its permissions deny group and other', (mode & 0o077) === 0, `mode ${mode.toString(8)}`);
  check('and grant the owner read and write', (mode & 0o600) === 0o600, `mode ${mode.toString(8)}`);

  // The load-bearing half. `mode` on `writeFileSync` applies only when the file is *created*,
  // so a write over one somebody had widened by hand would keep the widened permissions.
  chmodSync(registryFile, 0o666);

  // And the unlink is what makes the narrowing land on a file nobody else had open. A handle
  // taken before the write is the only way to tell the two apart: writing *into* the file would
  // show this reader the new contents, where unlinking leaves it holding the old ones until it
  // lets go. The inode number cannot answer it — ext4 hands the freed one straight back.
  const held = openSync(registryFile, 'r');
  const wasThere = readFileSync(registryFile, 'utf8');

  renameDevice(laptop.device.id, 'Work laptop again');

  const throughTheOldHandle = readFileSync(held, 'utf8');
  closeSync(held);
  const after = statSync(registryFile);
  check('a write over a widened file narrows it again', ((after.mode & 0o777) & 0o077) === 0,
        `mode ${(after.mode & 0o777).toString(8)}`);
  check('and a reader that had the old file open still has the old file',
        throughTheOldHandle === wasThere,
        'the write went into the file somebody was holding rather than replacing it');
  check('while the devices that were not revoked are all still there', listDevices().length === 2);
}

// ─── 7. A hand-edited file is "no devices", said out loud ─────

console.log('\n7. a malformed registry reads as no devices, and says so');

const rescue = readFileSync(registryFile, 'utf8');
writeFileSync(registryFile, '{ this is what an editor leaves behind', 'utf8');

let threw = null;
let readBack = null;
try { readBack = listDevices(); } catch (error) { threw = error; }
check('reading it does not throw', threw === null, threw?.message);
check('it reads as no devices at all', Array.isArray(readBack) && readBack.length === 0,
      JSON.stringify(readBack));
check('and nothing verifies against it', verifyDevice(laptopCredential) === null);
check('a read leaves the file alone rather than replacing what it could not parse',
      readFileSync(registryFile, 'utf8') === '{ this is what an editor leaves behind',
      'the operator has to be able to fix it by hand');

// The log file is where a board's own account of a start goes; the console transport is
// warn-and-above, so this is the surface a reader has for a file that was ignored.
let logged = '';
for (let attempt = 0; attempt < 40 && !/device/i.test(logged); attempt++) {
  await sleep(50);
  try { logged = readFileSync(logFile, 'utf8'); } catch { /* not written yet */ }
}
check('the log says which file was ignored', logged.includes(registryFile),
      logged.split('\n').filter(Boolean).slice(-3).join(' | ') || '(the log file is empty)');

writeFileSync(registryFile, JSON.stringify({ devices: 'not an array' }), 'utf8');
check('a file of the wrong shape reads as no devices too', listDevices().length === 0);

writeFileSync(registryFile, JSON.stringify({
  version: 1,
  devices: [
    { id: 'good', name: 'Kept', secretHash: 'a'.repeat(64), createdAt: '2026-08-03T10:00:00.000Z',
      lastSeenAt: null, approvedFrom: '127.0.0.1', host: 'board:3737' },
    { id: 'no-hash', name: 'Dropped', createdAt: '2026-08-03T10:00:00.000Z' },
    'not even an object',
  ],
}), 'utf8');
const survivors = listDevices();
check('a record with no hash is dropped and the rest are kept',
      survivors.length === 1 && survivors[0].id === 'good',
      JSON.stringify(survivors.map((device) => device.id)));

writeFileSync(registryFile, rescue, 'utf8');
check('and the real registry reads back once it is put right', listDevices().length === 2,
      JSON.stringify(listDevices().map((device) => device.name)));

// ─── 8. The compare, and who else reads the file ──────────────

console.log('\n8. the compare is constant-time, and one module owns the file');

const source = readFileSync(join(repoRoot, 'src', 'core', 'device-registry.ts'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('the module compares with timingSafeEqual', /timingSafeEqual\s*\(/.test(code),
      'a secret compared with === leaks how far a guess agreed, in the time it takes to say no');

// A `typeof x === 'string'` is an equality operator on a *type name* and is not what this is
// about; anything else standing beside a secret or a digest is.
const compared = code.split('\n')
  .filter((line) => !line.includes('typeof'))
  .filter((line) => /\b(secretHash|secret|digest|hash)\b[^\n]*(===|!==|==|!=)/.test(line)
                 || /(===|!==|==|!=)[^\n]*\b(secretHash|secret|digest|hash)\b/.test(line));
check('and never with an equality operator on a secret or a digest', compared.length === 0,
      compared.map((line) => line.trim()).join(' | '));
check('nor with startsWith, indexOf or localeCompare',
      !/\b(secretHash|secret|digest|hash)\b[^\n]*\.(startsWith|indexOf|localeCompare|includes)\(/.test(code));

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
  .filter((file) => !file.endsWith(`core${sep}device-registry.ts`))
  .filter((file) => readFileSync(file, 'utf8').includes(fileName))
  .map((file) => file.slice(repoRoot.length + 1));
check(`nothing else names ${fileName}`, otherReaders.length === 0, otherReaders.join(', '));

for (const name of ['addDevice', 'listDevices', 'verifyDevice', 'touchDevice', 'renameDevice',
                    'revokeDevice', 'deviceCredential', 'deviceRegistryPath']) {
  check(`the module owns ${name}`, typeof registry[name] === 'function');
}

// ─── Done ─────────────────────────────────────────────────────

rmSync(workDir, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
