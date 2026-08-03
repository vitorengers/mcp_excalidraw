import fs from 'fs';
import path from 'path';

import { stateDir, stateDirCandidates } from './settings.js';
import type { ApprovedDevice } from './pairing.js';
import logger from '../utils/logger.js';

/**
 * Where an approved device is written down, so that a restart does not un-approve it.
 *
 * This is the half of the credential story the token file cannot be. `core/auth-token.ts` holds
 * one secret, in plain text, regenerated on every start — right for what it defends, and wrong
 * for a second machine twice over: a device would lose access every time somebody pressed the
 * restart button on the bar, and there would be nothing to revoke short of a restart.
 *
 * So: one record per approved device, and the **hash** rather than the secret. The token file
 * has to hold plaintext because being readable *is* its handover mechanism; nothing reads this
 * one to learn a secret, only to check one, so there is no reason for the secret to be here at
 * all. Owner-only and unlinked-before-written for the same reasons `writeAuthToken` is, and the
 * comment there is the long version.
 *
 * A file somebody has hand-edited into nonsense reads as "no devices", loudly, and never throws:
 * a board that will not start because this file has a stray comma in it is a worse failure than
 * one that asks to pair again.
 *
 * **This is the smallest thing #503's handshake can be built on, and #502 is the module it
 * grows into.** Approving a device has to write it down somewhere or the approval is a gesture
 * that survives until teatime; what is here is add and list. Verify, touch, rename and revoke
 * belong to #502 and to the surface that manages them (#505), and they are deliberately absent
 * rather than half-present.
 */

/** One record per approved device, in the shape the pairing desk mints. */
export type DeviceRecord = ApprovedDevice;

interface RegistryFile {
  devices: DeviceRecord[];
}

export function devicesFilePath(): string {
  return path.join(stateDir(), 'devices.json');
}

/** Every place a registry could be, in the order a reader should try them. */
function devicesFilePaths(): string[] {
  return stateDirCandidates().map(dir => path.join(dir, 'devices.json'));
}

function isRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DeviceRecord>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.secretHash === 'string'
    && typeof candidate.host === 'string';
}

/**
 * The devices this board has approved, or none when there is no file to read.
 *
 * "None" is also the answer to a file that will not parse and to one whose contents are not the
 * shape this writes — said on the console, because a registry that has quietly become empty is
 * exactly the failure a reader would otherwise diagnose as "it forgot my laptop".
 */
export function listDevices(): DeviceRecord[] {
  for (const file of devicesFilePaths()) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // Not in this directory, which is the ordinary case for all but one of them.
    }
    try {
      const parsed = JSON.parse(raw) as RegistryFile;
      const devices = Array.isArray(parsed?.devices) ? parsed.devices.filter(isRecord) : null;
      if (!devices) throw new Error('no devices array');
      return devices;
    } catch (error) {
      logger.warn(`The paired-device registry at ${file} could not be read (${(error as Error).message}); `
        + 'this board is starting with no paired devices. Delete the file and pair again, or '
        + 'repair it by hand — nothing else in it is lost.');
      return [];
    }
  }
  return [];
}

/**
 * Add a device, and return the list as it now stands.
 *
 * Unlinked first for the reason `writeAuthToken` gives: `mode` on `writeFileSync` applies only
 * when the file is created, so writing over an existing one keeps whatever permissions that one
 * had, including permissions somebody widened by hand.
 *
 * Throws rather than warning. An approval the operator watched succeed, which then did not
 * survive the next restart, is the shape of failure this repository spends most of its comments
 * on — better a refusal the device can see than a pairing that quietly was not one.
 */
export function addDevice(device: DeviceRecord): DeviceRecord[] {
  const devices = [...listDevices().filter(entry => entry.id !== device.id), device];
  const file = devicesFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.unlinkSync(file); } catch { /* not there, which is the ordinary case */ }
  fs.writeFileSync(file, JSON.stringify({ devices }, null, 2), { encoding: 'utf-8', mode: 0o600 });
  // Windows has no POSIX mode bits and `chmod` there is close to a no-op; the file is protected
  // by the ACL on `%LOCALAPPDATA%` instead. Not an error either way.
  try { fs.chmodSync(file, 0o600); } catch { /* not this platform's idea of permissions */ }
  return devices;
}
