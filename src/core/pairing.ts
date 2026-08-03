import { createHash, randomBytes, randomInt, randomUUID } from 'crypto';

/**
 * The pairing handshake: a device asks, the host approves, and only the host may approve.
 *
 * The only credential this server had was the per-start token in `core/auth-token.ts`, written
 * where one account on one machine can read it. That is the right shape for what it defends and
 * it is no shape at all for a second machine: there is nothing to hand a laptop across the room
 * except the file itself, and handing over the file is handing over the board.
 *
 * So there is a gesture instead, and it is deliberately a gesture rather than a configuration
 * step. Open the board on the second machine; it finds no device secret and asks. The server
 * records the request and answers a **code**. The operator, on the machine the board is actually
 * running on, sees the request — with the code, the name it proposed, the authority it reached
 * this board under and the address it arrived from — and approves the one whose code matches
 * what they can read off the second screen. The secret is minted at that moment, handed to the
 * waiting page on its next poll, and never again.
 *
 * Four rules make that a gesture rather than a hole, and each of them is here rather than in the
 * routes because each of them is arithmetic somebody can get wrong:
 *
 *  - **The code is compared, not merely displayed.** Without it, a stranger's request racing the
 *    operator's own laptop is approved by somebody who assumed the dialog was about their laptop.
 *    The operator is choosing between requests, not confirming that one exists — so two live
 *    requests never carry the same code, and an approval that names the wrong one is refused.
 *  - **The secret is handed over exactly once**, and the record dies with it. A `requestId`
 *    polled after that answers as unknown, which is also what a `requestId` nobody issued
 *    answers: a poll is not a way to find out whether a request exists.
 *  - **The request route is the only one a stranger can reach**, so it is bounded — one live
 *    request per remote address, a ceiling overall, a short expiry — because what it does is put
 *    something on the operator's screen. A network that can fill that screen with prompts has
 *    found a way to make the operator stop reading them.
 *  - **Nothing here is persisted.** A pending request is a gesture in progress, held by an
 *    operator who is looking at two screens; a restart ends it, and ending it is correct. What
 *    survives a restart is the approved device, and that is the registry's job
 *    (`core/device-registry.ts`).
 *
 * The clock is a parameter rather than a call to `Date.now()`, so that the expiry and the
 * ceiling can be driven by a check without a check having to wait out an expiry — and an expiry
 * a check can wait out is too short to be one.
 */

/**
 * How long a request stays approvable.
 *
 * Long enough to walk to the other machine and read a code off it, short enough that a prompt
 * nobody answered is gone before the operator comes back to a screen full of them.
 */
export const PAIRING_EXPIRY_MS = 3 * 60 * 1000;

/**
 * How many live requests there may be at once, from however many addresses.
 *
 * The per-address limit is what stops one caller queueing; this is what stops a network of them.
 * Small on purpose: this is a list a person reads and compares a code against, and a list of
 * eight is already longer than the gesture was ever meant to be.
 */
export const PAIRING_MAX_PENDING = 8;

/**
 * How long an approved secret waits to be collected.
 *
 * Counted from the approval rather than from the request, because the operator's own thinking
 * time is inside the request's expiry: an approval at two minutes fifty-nine would otherwise
 * leave the waiting page one second to poll, and the failure would look like a board that
 * approved a device and then did not let it in.
 */
export const PAIRING_COLLECT_MS = 60 * 1000;

/** Why a request was not recorded. Reported to the caller as a status and no more. */
export type PairingRefusal = 'unnamed' | 'one-per-address' | 'too-many-pending';

/** What the operator is shown, and the whole of what a pending request is. */
export interface PendingPairing {
  requestId: string;
  /** Shown on both ends and compared by eye. Not a secret: a discriminator between requests. */
  code: string;
  /** What the device proposed to be called. The operator may still be looking at a stranger. */
  name: string;
  /** The socket the request arrived on, which is the one thing about it nobody can forge. */
  remoteAddress: string;
  /** The authority the device reached this board under — `mac.tailnet.ts.net:3737` and such. */
  host: string;
  createdAt: number;
  expiresAt: number;
}

/** A device the operator approved, in the shape the registry stores. */
export interface ApprovedDevice {
  id: string;
  name: string;
  /** The hash, never the secret: this server only ever verifies, and the device holds it. */
  secretHash: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** The address the request arrived from, recorded so a stale entry can be recognised later. */
  approvedFrom: string;
  /** The authority this device was approved *for*, which is what the origin gate needs. */
  host: string;
}

export type RequestOutcome =
  | { ok: true; pending: PendingPairing }
  | { ok: false; refusal: PairingRefusal };

export type ApproveOutcome =
  | { ok: true; device: ApprovedDevice; secret: string }
  | { ok: false; reason: 'unknown' | 'code-mismatch' };

export type PairingStatus =
  | { state: 'pending'; expiresAt: number }
  | { state: 'approved'; secret: string; deviceId: string }
  | { state: 'unknown' };

/**
 * One record, in whichever of its two lives it is in.
 *
 * The same `requestId` carries the gesture from "the operator has not looked yet" to "the secret
 * is minted and the device has not collected it", which is why this is one map and not two: a
 * `requestId` has exactly one answer at any moment, and the answer to a consumed one is the same
 * as the answer to one nobody issued.
 */
interface Record_ {
  pending: PendingPairing;
  approved: { device: ApprovedDevice; secret: string } | null;
}

/** A code a person reads off one screen and finds on another. Six digits, grouped. */
function newCode(): string {
  const digits = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

/** As long as the board token, and generated the same way, because it is the same kind of thing. */
function newSecret(): string {
  return randomBytes(32).toString('hex');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface PairingDesk {
  request(input: { name: string; remoteAddress: string; host: string; now?: number }): RequestOutcome;
  /** Every live request, for the operator to choose between. Never carries a secret. */
  pending(now?: number): PendingPairing[];
  approve(input: { requestId: string; code: string; now?: number }): ApproveOutcome;
  /** What the waiting device is told — and the one poll on which it is told the secret. */
  status(input: { requestId: string; now?: number }): PairingStatus;
}

/**
 * A desk of its own, rather than a module-level singleton.
 *
 * The server makes exactly one. A check makes as many as it has cases, which is the difference
 * between driving the ceiling and restarting a process eight times.
 */
export function createPairingDesk(): PairingDesk {
  const records = new Map<string, Record_>();

  /**
   * Forget everything that has run out, before answering anything.
   *
   * Swept here rather than on a timer: a timer would keep this process alive, would have to be
   * cleared on exit, and would make "has it expired" depend on when the timer last fired rather
   * than on what time it is. An approved-but-uncollected record expires on the same clock, so a
   * secret nobody came back for does not sit in memory until the board is restarted.
   */
  const sweep = (now: number): void => {
    for (const [requestId, record] of records) {
      if (record.pending.expiresAt <= now) records.delete(requestId);
    }
  };

  return {
    request({ name, remoteAddress, host, now = Date.now() }): RequestOutcome {
      sweep(now);
      const proposed = (name ?? '').trim();
      if (!proposed) return { ok: false, refusal: 'unnamed' };
      // Before the ceiling, so that a caller already holding the one slot it may have is told
      // which limit it met rather than being blamed for everybody else's.
      for (const record of records.values()) {
        if (record.pending.remoteAddress === remoteAddress) return { ok: false, refusal: 'one-per-address' };
      }
      if (records.size >= PAIRING_MAX_PENDING) return { ok: false, refusal: 'too-many-pending' };

      // Distinct among the live ones, because the operator's whole job here is to tell them
      // apart. Bounded rather than a loop that could in principle not finish: a million codes
      // against a ceiling of eight makes a collision rare and a run of them impossible.
      let code = newCode();
      for (let attempt = 0; attempt < 32; attempt++) {
        const taken = [...records.values()].some(record => record.pending.code === code);
        if (!taken) break;
        code = newCode();
      }

      const pending: PendingPairing = {
        requestId: randomUUID(),
        code,
        name: proposed.slice(0, 80),
        remoteAddress,
        host,
        createdAt: now,
        expiresAt: now + PAIRING_EXPIRY_MS,
      };
      records.set(pending.requestId, { pending, approved: null });
      return { ok: true, pending };
    },

    pending(now = Date.now()): PendingPairing[] {
      sweep(now);
      return [...records.values()]
        .filter(record => record.approved === null)
        .map(record => ({ ...record.pending }))
        .sort((left, right) => left.createdAt - right.createdAt);
    },

    approve({ requestId, code, now = Date.now() }): ApproveOutcome {
      sweep(now);
      const record = records.get(requestId);
      // A record already approved is not approvable again: the gesture is over and the only
      // thing left to happen to it is the device collecting its secret.
      if (!record || record.approved !== null) return { ok: false, reason: 'unknown' };
      if (record.pending.code !== code) return { ok: false, reason: 'code-mismatch' };

      const secret = newSecret();
      const device: ApprovedDevice = {
        id: randomUUID(),
        name: record.pending.name,
        secretHash: hashSecret(secret),
        createdAt: now,
        // Never, yet. The device has not come back with it, and until it does "approved" and
        // "in use" are different things the management surface has to be able to tell apart.
        lastSeenAt: null,
        approvedFrom: record.pending.remoteAddress,
        host: record.pending.host,
      };
      record.approved = { device, secret };
      // The clock restarts on the approval; see `PAIRING_COLLECT_MS`. A secret nobody comes back
      // for still expires, so it is not left in memory until the board is restarted.
      record.pending = { ...record.pending, expiresAt: now + PAIRING_COLLECT_MS };
      return { ok: true, device, secret };
    },

    status({ requestId, now = Date.now() }): PairingStatus {
      sweep(now);
      const record = records.get(requestId);
      if (!record) return { state: 'unknown' };
      if (!record.approved) return { state: 'pending', expiresAt: record.pending.expiresAt };
      // Handed over and forgotten in the same breath. A second poll finds nothing, which is
      // also what a `requestId` nobody issued finds.
      records.delete(requestId);
      return { state: 'approved', secret: record.approved.secret, deviceId: record.approved.device.id };
    },
  };
}

/**
 * Whether a caller reached this server from this machine.
 *
 * The socket's own address and nothing else. `X-Forwarded-For` is deliberately not consulted
 * anywhere near this: a header any caller can set would turn the one property of a request
 * nobody can forge into one everybody can, and a remote caller would approve itself by asking
 * politely. A reverse proxy reaches this server *on* loopback, so a proxied board keeps working
 * without any of this having to know the proxy exists.
 *
 * The whole of `127.0.0.0/8` rather than `127.0.0.1` alone, and the IPv6-mapped spelling of it
 * that Node hands back on a dual-stack socket, because those are the same machine under three
 * names.
 */
export function isLoopbackCaller(address: string | undefined | null): boolean {
  if (!address) return false;
  let candidate = address.trim().toLowerCase();
  if (!candidate) return false;
  // A scope suffix on a link-local IPv6 address — `fe80::1%eth0` — is not part of the address.
  const scope = candidate.indexOf('%');
  if (scope >= 0) candidate = candidate.slice(0, scope);
  if (candidate === '::1' || candidate === '[::1]') return true;
  if (candidate.startsWith('::ffff:')) candidate = candidate.slice('::ffff:'.length);
  const octets = candidate.split('.');
  if (octets.length !== 4) return false;
  if (octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return false;
  return octets[0] === '127';
}
