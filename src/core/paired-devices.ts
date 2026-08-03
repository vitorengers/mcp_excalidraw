import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { stateDir, stateDirCandidates } from './settings.js';

/**
 * The devices that may drive this board from somewhere other than the machine it runs on.
 *
 * `core/auth-token.ts` holds the other credential and the two are deliberately different
 * shapes. That one is **one secret, per start**, written in plaintext beside the pidfile
 * because being readable by this account *is* its handover mechanism; the filesystem's own
 * ACL is the whole of the defence and the token dying with the process is a feature. This
 * one is **many secrets, across restarts**, and every difference follows from that:
 *
 * - **Hashes, never the secret.** Nothing here can hand a device its credential back, and
 *   nothing needs to: the device is what holds it. A registry that stored plaintext would be
 *   a file whose disclosure is every paired machine at once, where the token file's is one
 *   process's lifetime.
 * - **Constant-time comparison**, for the reason `sameToken` gives, and over *every* record
 *   rather than stopping at the first match — an early return would leak, in time, which
 *   position a candidate collided at.
 * - **Persisted on purpose.** Surviving `POST /api/restart` is the point; a second machine
 *   that lost access every time somebody pressed a button on the bar is not a paired device.
 *
 * A malformed file reads as *no devices* and says so in the log. A board that will not start
 * because somebody opened this in an editor is a worse failure than one that asks to pair
 * again, and this file is exactly the shape of thing a person opens to see who is on the list.
 *
 * Nothing outside this module reads or writes the file. `src/server.ts` is the only caller.
 */

/** What one approved device is, as it is stored. */
export interface PairedDevice {
  /** Stable across renames, because the name is the part a person edits. */
  id: string;
  /** What the operator calls it. Seeded from what the device proposed, and editable. */
  name: string;
  /** `sha256` of the secret, hex. The secret itself is never written here. */
  secretHash: string;
  createdAt: string;
  /** Touched on every request the device makes, which is what tells in-use from forgotten. */
  lastSeenAt: string;
  /** The address the approval was granted from, verbatim, as the operator saw it. */
  approvedFrom: string;
  /** The authority this device was approved for — what the origin gate holds it to. */
  host: string;
}

/** A device as the management surface may see it: everything but the hash. */
export type PairedDeviceView = Omit<PairedDevice, 'secretHash'>;

/** The registry's own name. Not a setting: it belongs beside the pidfile, like the token. */
const REGISTRY_FILENAME = 'paired-devices.json';

export function pairedDevicesFilePath(): string {
  return path.join(stateDir(), REGISTRY_FILENAME);
}

/** Every directory a registry could be in, in the order a reader should try them. */
function pairedDevicesFilePaths(): string[] {
  return stateDirCandidates().map(dir => path.join(dir, REGISTRY_FILENAME));
}

function isDevice(value: unknown): value is PairedDevice {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.length > 0
    && typeof record.name === 'string'
    && typeof record.secretHash === 'string' && record.secretHash.length > 0;
}

/**
 * What is on disk, or an empty list.
 *
 * Never throws. Three ordinary causes of an unreadable file — it is not there, an editor left
 * it half-written, somebody deleted a comma — and none of them is a reason for a board not to
 * come up. The two that are not "not there" are logged, because a registry read as empty is
 * every paired device silently gone and the operator should be able to find out why.
 */
export function listDevices(): PairedDevice[] {
  for (const file of pairedDevicesFilePaths()) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // Not in this directory, which is the ordinary case for all but one of them.
    }
    try {
      const parsed = JSON.parse(raw);
      const devices = Array.isArray(parsed) ? parsed : (parsed as { devices?: unknown })?.devices;
      if (!Array.isArray(devices)) {
        logger.warn(`The paired-device registry at ${file} is not a list of devices; reading it `
                    + 'as no devices. Nothing was deleted — move it aside and pair again.');
        return [];
      }
      const kept = devices.filter(isDevice);
      if (kept.length !== devices.length) {
        logger.warn(`The paired-device registry at ${file} has ${devices.length - kept.length} `
                    + 'entry(ies) that are not devices; those were skipped.');
      }
      return kept.map(device => ({
        ...device,
        createdAt: typeof device.createdAt === 'string' ? device.createdAt : '',
        lastSeenAt: typeof device.lastSeenAt === 'string' ? device.lastSeenAt : '',
        approvedFrom: typeof device.approvedFrom === 'string' ? device.approvedFrom : '',
        host: typeof device.host === 'string' ? device.host : '',
      }));
    } catch (error) {
      logger.warn(`The paired-device registry at ${file} could not be read as JSON `
                  + `(${(error as Error).message}); reading it as no devices.`);
      return [];
    }
  }
  return [];
}

/** The list as the surface may have it: no hash leaves this module. */
export function viewOf(device: PairedDevice): PairedDeviceView {
  const { secretHash: _secretHash, ...rest } = device;
  return rest;
}

/**
 * Put the registry where this account, and only this account, can read it.
 *
 * Unlinked first, for the reason `writeAuthToken` gives and it is the same reason: `mode`
 * applies only when a file is *created*, so writing over one that already exists keeps
 * whatever permissions it had — including permissions somebody widened by hand.
 */
function writeDevices(devices: PairedDevice[]): void {
  const file = pairedDevicesFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.unlinkSync(file); } catch { /* not there, which is the ordinary case */ }
  fs.writeFileSync(file, `${JSON.stringify(devices, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  // Windows has no POSIX mode bits and `chmod` there is close to a no-op; the file is
  // protected by the ACL on `%LOCALAPPDATA%` instead, exactly as the token file is.
  try { fs.chmodSync(file, 0o600); } catch { /* not this platform's idea of permissions */ }
}

/** A fresh secret for a device to hold. Hex, because it travels in a header and a URL. */
export function newDeviceSecret(): string {
  return randomBytes(32).toString('hex');
}

export function hashDeviceSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Approve a device, and hand back the record. The secret is the caller's to deliver. */
export function addDevice(
  details: { name: string; secret: string; approvedFrom: string; host: string },
): PairedDevice {
  const now = new Date().toISOString();
  const device: PairedDevice = {
    id: randomUUID(),
    name: details.name.trim() || 'Unnamed device',
    secretHash: hashDeviceSecret(details.secret),
    createdAt: now,
    lastSeenAt: now,
    approvedFrom: details.approvedFrom,
    host: details.host,
  };
  writeDevices([...listDevices(), device]);
  return device;
}

/**
 * Which device holds this secret, if any.
 *
 * Every record is compared, and the answer is decided after the loop rather than inside it.
 * A `return` on the first match would take a time that depends on where in the list a
 * candidate collided, which is the same leak `sameToken` hashes to avoid — and this one has
 * a list to leak a *position* in as well as a prefix.
 */
export function verifyDeviceSecret(
  secret: string | null | undefined,
  devices: PairedDevice[] = listDevices(),
): PairedDevice | null {
  if (!secret) return null;
  const offered = createHash('sha256').update(secret).digest();
  let found: PairedDevice | null = null;
  for (const device of devices) {
    let stored: Buffer;
    try {
      stored = Buffer.from(device.secretHash, 'hex');
    } catch {
      continue;
    }
    // A hash of the wrong length is a hand-edited record, not a candidate: `timingSafeEqual`
    // throws on a length mismatch and the throw would be the answer rather than `false`.
    if (stored.length !== offered.length) continue;
    if (timingSafeEqual(stored, offered) && !found) found = device;
  }
  return found;
}

/**
 * Record that a device was heard from, cheaply enough to do on every request.
 *
 * Written at most once a minute per device. `lastSeenAt` is read by a person deciding whether
 * a laptop is still in use, and "within the last minute" is as fine as that question ever
 * gets — where a write per request would rewrite the whole registry, with `chmod`, for every
 * poll of every panel.
 */
const TOUCH_INTERVAL_MS = 60_000;

export function touchDevice(id: string, at: Date = new Date()): void {
  const devices = listDevices();
  const device = devices.find(entry => entry.id === id);
  if (!device) return;
  const previous = Date.parse(device.lastSeenAt);
  if (Number.isFinite(previous) && at.getTime() - previous < TOUCH_INTERVAL_MS) return;
  device.lastSeenAt = at.toISOString();
  writeDevices(devices);
}

/** Give a device the name its owner calls it. Null when there is no such device. */
export function renameDevice(id: string, name: string): PairedDevice | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const devices = listDevices();
  const device = devices.find(entry => entry.id === id);
  if (!device) return null;
  device.name = trimmed;
  writeDevices(devices);
  return device;
}

/**
 * Take a device off the list. The record that was removed, or null when it was not there.
 *
 * The refusal that follows is on the **next request**: every verification reads the file, so
 * there is no cached copy to invalidate and no restart to wait for. What this cannot do from
 * here is close a socket that is already open — an upgrade that has been accepted keeps
 * streaming the scene and every live shell's scrollback until somebody closes it — so
 * `src/server.ts` closes them, and `check-device-revoke-socket.mjs` is why.
 */
export function revokeDevice(id: string): PairedDevice | null {
  const devices = listDevices();
  const at = devices.findIndex(entry => entry.id === id);
  if (at < 0) return null;
  const removed = devices[at];
  devices.splice(at, 1);
  writeDevices(devices);
  return removed ?? null;
}
