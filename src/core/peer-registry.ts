import fs from 'fs';
import path from 'path';
// Before the logger, deliberately, for the reason `core/pidfile.ts`, `core/auth-token.ts` and
// `core/device-registry.ts` all give: the logger reads LOG_LEVEL and LOG_FILE_PATH in its own
// module body, so the configuration layers have to be in place before it is evaluated.
import { stateDir, stateDirCandidates } from './settings.js';
import logger from '../utils/logger.js';

/**
 * The boards that approved *this* machine, and how to reach them again.
 *
 * `core/device-registry.ts` is the mirror image of this file and the two are worth reading
 * together. That one is what a **host** keeps about machines it approved; this is what a
 * **device** keeps about hosts that approved it. Neither writes to the other and neither is told
 * when the other changes — `docs/federation.md` spells that asymmetry out, because it is the part
 * a reader has to be told rather than left to discover: forgetting a peer here does not revoke
 * the device there, and revoking there leaves a live record here that simply stops working.
 *
 * It differs from the device registry in exactly one way, and that one difference decides the
 * whole file. **The device registry holds a hash and never the secret**, because the host only
 * ever has to *check* one. This end has to *present* one, so it holds the secret in plaintext,
 * and the file's permissions are therefore the whole of its defence rather than a second belt
 * behind a digest. Everything below that looks like caution — the create mode, the `chmod`, the
 * rule that no line here may put a secret into a log call or a refusal — is that one fact being
 * paid for.
 *
 * **How it is written is the other difference, and it follows from what it is.** A token is
 * written once per start, so `writeAuthToken` can unlink and then create: nothing is reading a
 * file that did not exist a moment ago. A peer registry is *updated* — a peer is renamed, a peer
 * is forgotten — and between that unlink and that create the file is not there at all, which a
 * concurrent reader sees as "no peers" rather than as "wait a moment". So the update is
 * temp-file-and-rename, the way `core/workspaces.ts` already writes the workspace registry, with
 * the create-mode discipline applied to the temp file. The rename is the atomic swap that makes a
 * reader see the old file or the new one and never a truncated body, and because it replaces the
 * *inode* it also carries the narrow permissions onto a target somebody had widened by hand,
 * which is the job the unlink does in the token file.
 *
 * It lives beside `config.json`, `workspaces.json`, the pidfile, the token file and the device
 * registry: written with `stateDir()` and read across `stateDirCandidates()`, so the eventual
 * directory rename does not orphan somebody's peers. A file rather than a setting, because a peer
 * is a thing added and forgotten at runtime and a variable is a thing an operator pins once.
 *
 * The name of that neighbouring file is deliberately not spelled here. `check-device-registry.mjs`
 * holds it to one owner by reading every source for its name, and this module has no business
 * reading it — a comment that named it would trip that rule for a sentence, which is the rule
 * working rather than an obstacle to route around.
 *
 * Nothing outside this module reads or writes the file. Everything that has a question about a
 * peer asks one of the six functions below, and `scripts/check-peer-registry.mjs` holds the
 * repository to that.
 */

/**
 * One board that approved this one.
 *
 * `id` is the id that board gave this machine when it approved it — the public half of the
 * credential, which is also what names the record to forget. It is not minted here: the host
 * mints, this end records.
 *
 * `secret` is the plaintext this board presents. It is in the record rather than behind a second
 * function because presenting it is the only reason the record exists; what follows from that is
 * that a route answering with a list of peers has to *project* the fields it shows rather than
 * serialising these records, the way `docs/federation.md` says the project of a peer's workspaces
 * is built by naming the fields it includes.
 *
 * `lastSeenAt` is null until the peer is first reached, and null is a state rather than a missing
 * field: "added and never reached" and "last reached in March" are different answers to the
 * question somebody is asking when they look at a peer that is not answering.
 */
export interface PeerRecord {
  /** The id that board approved this one under. Public: it travels in the credential. */
  id: string;
  /** What this operator calls that machine. Theirs to change; nothing keys on it. */
  name: string;
  /** Where that board answers: scheme, host and port, and nothing after them. */
  baseUrl: string;
  /** The secret to present. Plaintext, because this end presents rather than checks. */
  secret: string;
  addedAt: string;
  lastSeenAt: string | null;
}

/** What a caller hands in. The id and the secret come from the board that approved this one. */
export interface NewPeer {
  id: string;
  name?: string;
  baseUrl: string;
  secret: string;
}

/**
 * Why a peer was not added, in words a surface can show.
 *
 * A refusal rather than a throw, and never carrying the secret it was handed: a refusal is the
 * one value in this module that gets logged, rendered into a dialog and pasted into an issue by
 * somebody asking for help, so it is the one place a plaintext secret would escape the file whose
 * permissions are the whole defence.
 */
export interface PeerRefused {
  ok: false;
  error: string;
}

export interface PeerAdded {
  ok: true;
  peer: PeerRecord;
}

export type PeerAddResult = PeerAdded | PeerRefused;

interface RegistryFile {
  version: number;
  peers: PeerRecord[];
}

const REGISTRY_VERSION = 1;
const REGISTRY_FILE = 'peers.json';

/** Beside `config.json`, the pidfile and the device registry, and for the same reason. */
export function peerRegistryPath(): string {
  return path.join(stateDir(), REGISTRY_FILE);
}

/** Every place a registry could be, in the order a reader should try them. */
function peerRegistryPaths(): string[] {
  return stateDirCandidates().map(dir => path.join(dir, REGISTRY_FILE));
}

/**
 * Said once per distinct complaint.
 *
 * A malformed file is read on every call that asks about a peer, and a line per read is a
 * megabyte of the same sentence. `warn` rather than `info` because this one has to reach the
 * console too: the file the operator has just broken is the reason their other machine's tabs
 * went away.
 */
const complained = new Set<string>();
function complain(message: string): void {
  if (complained.has(message)) return;
  complained.add(message);
  logger.warn(message);
}

/**
 * The address a peer answers on, reduced to the three things that are an address, or null.
 *
 * Scheme, host and port — and deliberately nothing else. A stored `baseUrl` is going to be
 * concatenated with a path on every request this board makes to that machine, so anything left on
 * the end of it changes where those requests go: a path turns `${baseUrl}/api/workspaces` into
 * something nobody wrote, and a query or a fragment swallows whatever is appended to it entirely.
 * Refused rather than trimmed off, because a caller that handed in an address with a path meant
 * something by it and a silent truncation is the same class of surprise the other way round.
 *
 * Credentials are refused for the same reason and one more: a `user:password@` in a stored URL is
 * a second secret in the same file, in a field nothing here knows is one.
 *
 * The parse is the WHATWG one, so it agrees with what a browser and `fetch` would make of the
 * same string — which is what closes the `http://good.example\@evil.example/` shape, where a
 * backslash reads as a separator and the authority is not the one the text appears to name. That
 * arrives here as a path on `good.example` and is refused with the rest.
 */
function readBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const given = value.trim();
  if (!given) return null;

  let parsed: URL;
  try {
    parsed = new URL(given);
  } catch {
    return null; // not a URL at all, or a port outside the range a port has
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  // `new URL('http://board.example')` and `…/` both normalise to a pathname of `/`, so the two
  // spellings an operator would type of the same address are one address here.
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  if (parsed.search || parsed.hash) return null;
  // A port of `0` parses and is not a port anything answers on. Every other out-of-range value
  // already failed the parse above.
  if (parsed.port === '0') return null;

  // `origin` is exactly scheme, host and port for an http URL, with the host lower-cased and the
  // scheme's default port dropped — the normalisation this wants, from the parser rather than
  // from string work here.
  return parsed.origin;
}

/** Whether a parsed record is one this board is willing to present a credential from. */
function readRecord(value: unknown): PeerRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const stored = typeof entry.secret === 'string' ? entry.secret : '';
  const baseUrl = readBaseUrl(entry.baseUrl);
  // The three load-bearing fields, and a record missing any of them is not a peer: without an id
  // nothing can name it, without an address there is nowhere to go, and without a secret there is
  // nothing to present when it gets there. The rest are for whoever reads the list and are
  // defaulted rather than refused, so one hand-typed name cannot drop a working link.
  if (!id || !stored || !baseUrl) return null;
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
    baseUrl,
    secret: stored,
    addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : '',
    lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : null
  };
}

/**
 * The registry as it is on disk *right now*.
 *
 * Read on every call, with nothing memoised, for the reason `core/device-registry.ts` gives about
 * its own file: the process that forgets a peer is not always the process that presents its
 * credential, and a cache here would make `forgetPeer` a promise about the future rather than a
 * thing that has happened.
 *
 * Never throws. A malformed or hand-edited file reads as "no peers", said out loud once: a board
 * that will not start because somebody opened this in an editor is a worse failure than one whose
 * peer tabs are missing, and it is a *silent* worse failure — the board comes up, reports itself
 * healthy, and does nothing.
 */
function readRegistry(): RegistryFile {
  for (const file of peerRegistryPaths()) {
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
        + 'No peer board is known until it is repaired or a peer is added again.');
      return { version: REGISTRY_VERSION, peers: [] };
    }

    const entries = (parsed as { peers?: unknown } | null)?.peers;
    if (!Array.isArray(entries)) {
      complain(`Ignoring ${file}: it must be a JSON object with a "peers" array. `
        + 'No peer board is known until it is repaired or a peer is added again.');
      return { version: REGISTRY_VERSION, peers: [] };
    }

    const kept = entries.map(readRecord).filter((peer): peer is PeerRecord => peer !== null);
    if (kept.length !== entries.length) {
      complain(`Ignoring ${entries.length - kept.length} entr(ies) in ${file}: `
        + 'a peer needs an id, a baseUrl and something to present.');
    }
    return { version: REGISTRY_VERSION, peers: kept };
  }
  return { version: REGISTRY_VERSION, peers: [] };
}

/**
 * How many times a rename is worth retrying, and how long to wait between attempts.
 *
 * Windows only, in practice. A `rename` over a file another process has open succeeds there
 * because libuv opens with `FILE_SHARE_DELETE`, but an indexer or a virus scanner holding it
 * without that flag makes the swap fail for a few milliseconds at a time. Retried rather than
 * thrown at, because the alternative — falling back to a write in place — is exactly the failure
 * this whole function is shaped to avoid.
 */
const RENAME_ATTEMPTS = 20;
const RENAME_WAIT_MS = 5;

/** A synchronous wait, because everything on this path is synchronous and has to stay so. */
function waitBriefly(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Put the registry where this account, and only this account, can read it — without ever leaving
 * a reader holding nothing, or half of it.
 *
 * Three steps, and each is answering a different failure:
 *
 * 1. **The temp file is unlinked before it is created.** `mode` on `writeFileSync` applies only
 *    when a file is *created*, so a leftover temp from a crashed run — or one somebody widened by
 *    hand — would otherwise keep its permissions and this file is plaintext. This is
 *    `writeAuthToken`'s own order, moved onto the file nobody is reading.
 * 2. **`chmod` afterwards**, for a filesystem that took the creation mode and did something else
 *    with it. Tolerated on Windows, which has no POSIX mode bits and protects the directory by
 *    ACL instead.
 * 3. **The swap is a rename.** A reader sees the old inode or the new one, and there is no
 *    instant at which the target is missing or truncated. It is also what re-narrows a target
 *    somebody had widened, since the file that ends up there is the one created at `0600`.
 *
 * Throws rather than warning. A registry that cannot be written is a peer that reports itself
 * added and is gone on the next read, which is exactly the shape of failure this repository
 * spends its comments on.
 */
function writeRegistry(file: RegistryFile): void {
  const target = peerRegistryPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const temporary = `${target}.${process.pid}.tmp`;
  try { fs.unlinkSync(temporary); } catch { /* not there, which is the ordinary case */ }
  fs.writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch { /* not this platform's idea of permissions */ }

  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(temporary, target);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS) {
        try { fs.unlinkSync(temporary); } catch { /* leave no half-written copy behind */ }
        throw error;
      }
      waitBriefly(RENAME_WAIT_MS);
    }
  }
}

/** Every peer board, oldest first. The answer to "which boards approved this machine". */
export function listPeers(): PeerRecord[] {
  return readRegistry().peers;
}

/**
 * The peer behind an id, or null.
 *
 * Reads the file, so a peer forgotten a moment ago by anybody — the CLI, a second process, a
 * management surface — is not found here.
 */
export function getPeer(id: unknown): PeerRecord | null {
  if (typeof id !== 'string' || !id.trim()) return null;
  const wanted = id.trim();
  return readRegistry().peers.find(peer => peer.id === wanted) ?? null;
}

/**
 * Write down a board that approved this one.
 *
 * Nothing is minted here: the id and the secret are what the other machine handed over when it
 * approved this one, and this end records them. The address is normalised and validated on the
 * way in, so a stored entry cannot later be concatenated into a request that goes somewhere else.
 *
 * An id already on the list is refused rather than overwritten, and the refusal names the entry
 * that holds it: two peers under one id is one link silently replacing another, and the id is the
 * half of a credential a person recognises. Re-approving the same machine is a forget and an add,
 * which is two deliberate gestures rather than one accident.
 */
export function addPeer(request: NewPeer | null | undefined): PeerAddResult {
  const id = typeof request?.id === 'string' ? request.id.trim() : '';
  if (!id) {
    return { ok: false, error: 'A peer needs the id the other board approved this one under.' };
  }

  const baseUrl = readBaseUrl(request?.baseUrl);
  if (!baseUrl) {
    // The value is quoted because a typo is the ordinary cause and an operator cannot fix one
    // they cannot see. The secret never is, for the reason `PeerRefused` gives.
    const given = typeof request?.baseUrl === 'string' ? request.baseUrl.trim() : '';
    return {
      ok: false,
      error: `"${given}" is not an address a board answers on. It has to be an http or https URL `
        + 'naming a host and, where it is not the default, a port — and nothing after them: a '
        + 'path, a query, a fragment or credentials in the address would each change where this '
        + 'board\'s requests to that machine end up. Nothing was written.',
    };
  }

  if (typeof request?.secret !== 'string' || !request.secret) {
    return {
      ok: false,
      error: `A peer needs the credential the board at ${baseUrl} issued to this one; `
        + 'without it there is nothing to present and the link would be a row that never works. '
        + 'Nothing was written.',
    };
  }

  const registry = readRegistry();
  const taken = registry.peers.find(peer => peer.id === id);
  if (taken) {
    return {
      ok: false,
      error: `The id "${id}" is already held by the peer "${taken.name}" at ${taken.baseUrl}. `
        + 'Forget that one first if this is the same machine under a new address. Nothing was written.',
    };
  }

  const peer: PeerRecord = {
    id,
    name: typeof request.name === 'string' && request.name.trim() ? request.name.trim() : id,
    baseUrl,
    secret: request.secret,
    addedAt: new Date().toISOString(),
    lastSeenAt: null
  };
  registry.peers.push(peer);
  writeRegistry(registry);
  logger.info(`Added peer board ${peer.id} (${peer.name}) at ${peer.baseUrl}`);
  return { ok: true, peer };
}

/** Give a peer the name its operator calls it. False when there is no such peer. */
export function renamePeer(id: string, name: string): boolean {
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (!wanted) return false;
  return amend(id, peer => { peer.name = wanted; });
}

/** Write down that a peer answered just now. False when there is no such peer any more. */
export function touchPeer(id: string, at: Date = new Date()): boolean {
  return amend(id, peer => { peer.lastSeenAt = at.toISOString(); });
}

/**
 * Drop a peer, and the secret with it. False when it was not there, which is not an error.
 *
 * This end only. The device record on the other machine is untouched and stays on that operator's
 * list until they revoke it — `docs/federation.md` says so out loud, because assuming otherwise is
 * what leaves a row nobody recognises on a list somebody reads in six months.
 */
export function forgetPeer(id: unknown): boolean {
  const wanted = typeof id === 'string' ? id.trim() : '';
  if (!wanted) return false;
  const registry = readRegistry();
  const peer = registry.peers.find(entry => entry.id === wanted);
  if (!peer) return false;
  registry.peers = registry.peers.filter(entry => entry.id !== wanted);
  writeRegistry(registry);
  logger.info(`Forgot peer board ${peer.id} (${peer.name}) at ${peer.baseUrl}; `
    + 'the device record on that machine is untouched and is theirs to revoke');
  return true;
}

/** Read, change one record, write. The two amendments above are the same shape. */
function amend(id: unknown, change: (peer: PeerRecord) => void): boolean {
  const wanted = typeof id === 'string' ? id.trim() : '';
  if (!wanted) return false;
  const registry = readRegistry();
  const peer = registry.peers.find(entry => entry.id === wanted);
  if (!peer) return false;
  change(peer);
  writeRegistry(registry);
  return true;
}
