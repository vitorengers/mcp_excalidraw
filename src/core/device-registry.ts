import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
// Before the logger, deliberately, for the reason `core/pidfile.ts` and `core/auth-token.ts`
// both give: the logger reads LOG_LEVEL and LOG_FILE_PATH in its own module body, so the
// configuration layers have to be in place before it is evaluated.
import { stateDir, stateDirCandidates } from './settings.js';
import logger from '../utils/logger.js';

/**
 * The devices a person has approved to drive this board from somewhere else.
 *
 * The only credential this server had was `AUTH_TOKEN` (`core/auth-token.ts`): one secret,
 * generated at startup, written beside the pidfile with owner-only permissions. That is the
 * right shape for what it defends — one operator, one machine, the filesystem's own ACL — and
 * it is the wrong shape for a second machine twice over.
 *
 * - **It is per start**, and the reason for that is good: a token that outlived the process
 *   would still be valid for whatever came next on that port. But it means a second device
 *   loses access on every restart, and `POST /api/restart` is a button on the bar.
 * - **It is one secret.** There is nothing to revoke short of restarting, and no way to answer
 *   "which devices can drive this board" — the question a person asks the moment there is more
 *   than one.
 *
 * So this is the other half, and the differences from the token file are all deliberate:
 *
 * - **Persisted.** Surviving a restart is the whole point; a device that had to be paired again
 *   every time the board came back is the token with extra steps.
 * - **A hash, never the secret.** The device is what holds the secret and the server only ever
 *   verifies one. The token file has to hold plaintext because being readable *is* its handover
 *   mechanism; nothing here is ever handed over after the pairing, so nothing here is plaintext.
 *   A readable `devices.json` is therefore a list of devices and not a set of credentials.
 * - **One record per device**, so revoking is a thing that exists at all, and so a management
 *   surface can say which of them is actually in use rather than merely listing them.
 *
 * What it shares with the token file is the compare — `timingSafeEqual` over digests, so that a
 * refusal costs the same whatever a guess had in common with the truth — and the way the file is
 * written: unlinked first, then created with owner-only permissions, because `mode` on
 * `writeFileSync` applies only when a file is *created* and a write over one somebody widened by
 * hand would otherwise keep the widened permissions.
 *
 * Nothing outside this module reads or writes the file. Everything that has a question about a
 * device asks one of the seven functions below, and `scripts/check-device-registry.mjs` holds
 * the repository to that.
 */

/**
 * One approved device.
 *
 * `host` is the authority the device was approved *for*, which is what the origin gate needs
 * (`core/origin-gate.ts`). It is per device rather than global on purpose: approving a laptop
 * that reaches this board as `board.tail-scale.ts.net:3737` must not bless that name for
 * everybody who comes after.
 *
 * `lastSeenAt` is null until the device is first seen, and null is a state rather than a missing
 * field: "paired and never used" and "last used in March" are different answers to the question
 * a person is asking when they look at this list.
 */
export interface DeviceRecord {
  /** Opaque, and public: it travels in the credential and names the record to revoke. */
  id: string;
  /** What the person called it when they approved it. Theirs to change; nothing keys on it. */
  name: string;
  /** SHA-256 of the secret, hex. The secret itself is never written anywhere. */
  secretHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** The address the approval was made from, for the person reading the list later. */
  approvedFrom: string;
  /** The authority this device reaches the board on. */
  host: string;
}

/** What a pairing answers with: the record to show, and the secret to hand over exactly once. */
export interface PairedDevice {
  device: DeviceRecord;
  /** The only time this value exists outside the device. It is not stored and cannot be re-read. */
  secret: string;
}

export interface DeviceApproval {
  name: string;
  host: string;
  approvedFrom: string;
}

interface RegistryFile {
  version: number;
  devices: DeviceRecord[];
}

const REGISTRY_VERSION = 1;
const REGISTRY_FILE = 'devices.json';

/** The separator between the two halves of a credential. Not in either half: both are hex. */
const CREDENTIAL_SEPARATOR = '.';

/** Beside `config.json` and the pidfile, and for the same reason: it is this account's state. */
export function deviceRegistryPath(): string {
  return path.join(stateDir(), REGISTRY_FILE);
}

/** Every place a registry could be, in the order a reader should try them. */
function deviceRegistryPaths(): string[] {
  return stateDirCandidates().map(dir => path.join(dir, REGISTRY_FILE));
}

/**
 * What a device sends: its id and its secret, in one opaque string.
 *
 * One string rather than two because it has to travel everywhere a bearer token travels — a
 * header, a query parameter on a WebSocket handshake, a value pasted into a configuration file —
 * and every one of those places has room for exactly one value. The id half is not secret and is
 * what makes the lookup a lookup rather than a scan of every record.
 */
export function deviceCredential(id: string, secret: string): string {
  return `${id}${CREDENTIAL_SEPARATOR}${secret}`;
}

/**
 * Said once per distinct complaint.
 *
 * A malformed file is read on every request that asks about a device, and a line per read is a
 * megabyte of the same sentence. `warn` rather than `info` because this one has to reach the
 * console too: the file the operator has just broken is the reason their phone stopped working.
 */
const complained = new Set<string>();
function complain(message: string): void {
  if (complained.has(message)) return;
  complained.add(message);
  logger.warn(message);
}

/** Whether a parsed record is one this server is willing to verify against. */
function readRecord(value: unknown): DeviceRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const secretHash = typeof entry.secretHash === 'string' ? entry.secretHash.trim() : '';
  // The two load-bearing fields: without an id nothing can name this record, and without a hash
  // there is nothing to verify against — a record missing either is not a device, whatever else
  // it carries. The rest are for the person reading the list and are defaulted rather than
  // refused, so that one hand-typed name cannot lock a device out.
  if (!id || !secretHash) return null;
  const text = (name: string, fallback: string): string =>
    typeof entry[name] === 'string' ? entry[name] as string : fallback;
  return {
    id,
    name: text('name', id),
    secretHash,
    createdAt: text('createdAt', ''),
    lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : null,
    approvedFrom: text('approvedFrom', ''),
    host: text('host', '')
  };
}

/**
 * The registry as it is on disk *right now*.
 *
 * Read on every call, with nothing memoised, and that is the feature rather than an oversight.
 * A revocation has to refuse the device on the **next request**, not on the next restart — and
 * the process that revokes is not always the process that verifies: the CLI, a second board, a
 * management surface. A cache here would make `revoke` a promise about the future, and a
 * credential that goes on working after somebody took it away is the whole failure this exists
 * to prevent. The file is a few hundred bytes and the read is a `readFileSync` against the page
 * cache; the correctness is worth more than the syscall.
 *
 * Never throws. A malformed or hand-edited file reads as "no devices", said out loud once: a
 * board that will not start because somebody opened this in an editor is a worse failure than
 * one that asks to pair again, and it is a *silent* worse failure — the board comes up, reports
 * itself healthy, and refuses everything.
 */
function readRegistry(): RegistryFile {
  for (const file of deviceRegistryPaths()) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // not in this directory, which is the ordinary case for all but one of them
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      complain(`Ignoring ${file}: it is not valid JSON (${(error as Error).message}). `
        + 'No device is paired until it is repaired or a device is approved again.');
      return { version: REGISTRY_VERSION, devices: [] };
    }

    const devices = (parsed as { devices?: unknown } | null)?.devices;
    if (!Array.isArray(devices)) {
      complain(`Ignoring ${file}: it must be a JSON object with a "devices" array. `
        + 'No device is paired until it is repaired or a device is approved again.');
      return { version: REGISTRY_VERSION, devices: [] };
    }

    const kept = devices.map(readRecord).filter((device): device is DeviceRecord => device !== null);
    if (kept.length !== devices.length) {
      complain(`Ignoring ${devices.length - kept.length} entr(ies) in ${file}: `
        + 'a device needs an id and a secretHash.');
    }
    return { version: REGISTRY_VERSION, devices: kept };
  }
  return { version: REGISTRY_VERSION, devices: [] };
}

/**
 * Put the registry where this account, and only this account, can read it.
 *
 * `writeAuthToken` in `core/auth-token.ts`, and for the same reasons in the same order: unlink
 * first so the creation mode applies to a file nobody else had open, `chmod` afterwards for a
 * filesystem that took the creation mode and did something else with it, and both of them
 * tolerated on Windows, which has no POSIX mode bits and protects the directory by ACL instead.
 *
 * Throws rather than warning. A registry that cannot be written is a pairing that reports
 * success and is gone on the next request, which is exactly the shape of failure this repository
 * spends its comments on.
 */
function writeRegistry(file: RegistryFile): void {
  const target = deviceRegistryPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.unlinkSync(target); } catch { /* not there, which is the ordinary case */ }
  fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* not this platform's idea of permissions */ }
}

/** Every approved device, oldest first. The answer to "which devices can drive this board". */
export function listDevices(): DeviceRecord[] {
  return readRegistry().devices;
}

/**
 * Approve a device, and hand back the one copy of its secret there will ever be.
 *
 * 32 bytes, like the board's own token: this is a bearer credential that travels through a URL
 * and a header, so it is hex, and it has enough entropy that a single SHA-256 is the right way
 * to store it. A password would need a slow hash because a person chose it; nothing chose this
 * but `randomBytes`, and there is no dictionary for 256 bits.
 */
export function addDevice(approval: DeviceApproval): PairedDevice {
  const secret = randomBytes(32).toString('hex');
  const device: DeviceRecord = {
    id: randomBytes(8).toString('hex'),
    name: approval.name.trim() || 'Unnamed device',
    secretHash: hashSecret(secret).toString('hex'),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    approvedFrom: approval.approvedFrom,
    host: approval.host
  };
  const file = readRegistry();
  file.devices.push(device);
  writeRegistry(file);
  logger.info(`Paired device ${device.id} (${device.name}) for ${device.host || 'this board'}, `
    + `approved from ${device.approvedFrom || 'an unrecorded address'}`);
  return { device, secret };
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/**
 * Whether an offered secret is the one behind a stored digest, in time that does not depend on
 * how far the two agree.
 *
 * `sameToken` in `core/auth-token.ts` is the same idea against two plaintexts. Here one side is
 * already a digest, so only the offered side is hashed — and the length guard is the same one
 * for the same reason: `timingSafeEqual` throws on a length mismatch, and the length of a
 * rejected candidate is not something to answer a caller with. A stored value that is not 32
 * bytes of hex is compared against a decoy of the right length and refused, so a broken record
 * costs a caller the same as a wrong guess.
 */
function sameSecret(offered: string, stored: string): boolean {
  const candidate = hashSecret(offered);
  const expected = Buffer.from(stored, 'hex');
  if (expected.length !== candidate.length) {
    timingSafeEqual(candidate, candidate);
    return false;
  }
  return timingSafeEqual(candidate, expected);
}

/** A record no device can have, for the compare an unknown id still has to pay for. */
const DECOY = randomBytes(32).toString('hex');

/**
 * The device behind a credential, or null.
 *
 * Reads the file, so a device revoked a moment ago by anybody is refused here. Does **not**
 * write: `touchDevice` is separate so that a caller decides how often "last seen" is worth a
 * write, rather than this turning every request into one.
 *
 * An unknown id is refused *after* a compare against `DECOY`, so that "no such device" and
 * "wrong secret" take the same time. Without it the timing says which ids exist, and the ids
 * are the half of a credential a person copies into a configuration file.
 */
export function verifyDevice(credential: string | null | undefined): DeviceRecord | null {
  if (typeof credential !== 'string' || !credential) return null;
  const cut = credential.indexOf(CREDENTIAL_SEPARATOR);
  if (cut <= 0) return null;
  const id = credential.slice(0, cut);
  const secret = credential.slice(cut + 1);
  if (!secret) return null;

  const device = readRegistry().devices.find(entry => entry.id === id);
  if (!device) {
    sameSecret(secret, DECOY);
    return null;
  }
  return sameSecret(secret, device.secretHash) ? device : null;
}

/** Write down that a device was seen just now. False when there is no such device any more. */
export function touchDevice(id: string, at: Date = new Date()): boolean {
  return amend(id, device => { device.lastSeenAt = at.toISOString(); });
}

/** Give a device the name its owner calls it. False when there is no such device. */
export function renameDevice(id: string, name: string): boolean {
  const wanted = name.trim();
  if (!wanted) return false;
  return amend(id, device => { device.name = wanted; });
}

/**
 * Take a device's access away. False when it was not there, which is not an error: two people
 * pressing revoke on the same device is the ordinary way that happens.
 *
 * The record is removed rather than marked, because a revoked device that is kept is a hash an
 * attacker can still work against and a row a person has to read past. What is worth keeping
 * about a device that is gone is a log line, and that is what this writes.
 */
export function revokeDevice(id: string): boolean {
  const file = readRegistry();
  const device = file.devices.find(entry => entry.id === id);
  if (!device) return false;
  file.devices = file.devices.filter(entry => entry.id !== id);
  writeRegistry(file);
  logger.info(`Revoked device ${device.id} (${device.name}); it is refused from the next request`);
  return true;
}

/** Read, change one record, write. The three amendments above are the same shape. */
function amend(id: string, change: (device: DeviceRecord) => void): boolean {
  const file = readRegistry();
  const device = file.devices.find(entry => entry.id === id);
  if (!device) return false;
  change(device);
  writeRegistry(file);
  return true;
}
