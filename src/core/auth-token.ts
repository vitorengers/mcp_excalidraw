import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
// Before the logger, deliberately, for the reason `core/pidfile.ts` gives: importing the logger
// applies nothing, but it reads LOG_LEVEL and LOG_FILE_PATH in its own module body, so the
// configuration layers have to be in place first.
import { env, stateDir, stateDirCandidates } from './settings.js';
import { DEFAULT_CANVAS_PORT } from './port.js';

/**
 * A secret this start of the canvas server knows, written where only this account can read it.
 *
 * Until #350 there was no authentication anywhere, and the whole of the control was the loopback
 * bind: every other process on the machine — a second user account, a sandboxed process, an npm
 * `postinstall` in a project the operator has just opened — could drive an API that spawns coding
 * agents and real shells. Loopback is not a permission boundary between users, and
 * [SECURITY.md](../../docs/SECURITY.md) said so rather than closing it.
 *
 * What closes it is a **file**, not a password: the server generates a token at startup and
 * writes it beside its pidfile with owner-only permissions, and everything that may drive the
 * board reads it from there. The operator never types it, so there is nothing to remember, to
 * rotate or to put in a configuration file — and the defence is exactly the filesystem's own,
 * which is the boundary the operating system already maintains between accounts. A process
 * running *as the operator* can read the file, and this defends against nothing there; that is
 * the deliberate limit of the control and is written down in `docs/SECURITY.md`.
 *
 * Per start rather than per install: a token that outlived the process would sit in a file
 * forever and would still be valid for whatever came next on that port.
 */

/**
 * The names, from the module the page shares with this one.
 *
 * - `TOKEN_HEADER` is how a program hands the token over: out of the address bar and out of
 *   anything that logs a URL.
 * - `TOKEN_QUERY` is how a *socket* does, and it is not a convenience. A browser's `WebSocket`
 *   constructor takes a URL and nothing else, so there is no header to set on the handshake and
 *   the query parameter is the only door the upgrade has. Accepted on ordinary requests too, so
 *   `curl` and a check script have one spelling that works everywhere.
 * - `LAUNCH_QUERY` is what the launcher puts in the address bar, and it is deliberately not
 *   `TOKEN_QUERY`: the page consumes it once and strips it, where `token` is sent on every
 *   request. Two lifetimes, so two names.
 */
export { TOKEN_HEADER, TOKEN_QUERY, LAUNCH_QUERY } from './board-token.js';
import { TOKEN_HEADER, LAUNCH_QUERY } from './board-token.js';

/** A fresh secret. 32 bytes, hex, because it is copied through a URL and a header. */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Whether this process requires a token at all.
 *
 * The opt-out exists for the ~130 checks in `scripts/`, which each start a throwaway server and
 * drive it over plain `fetch`, and it is set in exactly one place for them
 * (`scripts/lib/spawn-canvas.mjs`). The alternative was every check reading the token file the
 * server it just spawned wrote — around a hundred and fifty `fetch` call sites and
 * twenty-seven browser navigations — and the cost of *that* is a hundred and fifty chances to
 * write a check that passes because it forgot the header. This is one switch, in one file, and
 * a server that has it says so on the way up.
 */
export function authRequired(): boolean {
  return env('NO_AUTH') !== '1';
}

/** Beside `server-<port>.pid`, and for the same reason: it is runtime state about this port. */
export function tokenFilePath(port: number): string {
  return path.join(stateDir(), `server-${port}.token`);
}

/** Every place a token file for `port` could be, in the order a reader should try them. */
export function tokenFilePaths(port: number): string[] {
  return stateDirCandidates().map(dir => path.join(dir, `server-${port}.token`));
}

/**
 * Put the token where this account, and only this account, can read it.
 *
 * Replaced rather than overwritten: the `mode` on `writeFileSync` applies at *creation*, so a
 * file left behind by an earlier start would keep whatever permissions it had. And chmodded
 * afterwards as well, because the creation mode is masked by the process umask — a umask of
 * `0o077` would be no problem and a umask of `0` would have written `0o600` as `0o600`, but
 * nothing here gets to assume which one the operator has.
 *
 * Throws rather than warning. A board whose token nobody can read is a board nothing can drive,
 * answering `status: healthy` the whole time, which is the shape of failure this repository
 * spends most of its comments on.
 */
export function writeAuthToken(port: number, token: string): string {
  const file = tokenFilePath(port);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.unlinkSync(file); } catch { /* not there, which is the ordinary case */ }
  fs.writeFileSync(file, token, { encoding: 'utf-8', mode: 0o600 });
  // Windows has no POSIX mode bits and `chmod` there is close to a no-op; the file is protected
  // by the ACL on `%LOCALAPPDATA%` instead. Not an error either way.
  try { fs.chmodSync(file, 0o600); } catch { /* not this platform's idea of permissions */ }
  return token;
}

/** The token of the server on `port`, or null when there is no file — an older or opted-out one. */
export function readAuthToken(port: number): string | null {
  for (const file of tokenFilePaths(port)) {
    try {
      const raw = fs.readFileSync(file, 'utf-8').trim();
      if (raw) return raw;
    } catch { /* not in this directory */ }
  }
  return null;
}

export function removeAuthToken(port: number): void {
  for (const file of tokenFilePaths(port)) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

/**
 * Whether two tokens are the same, in time that does not depend on how far they agree.
 *
 * Hashed first so that `timingSafeEqual` gets two buffers of equal length whatever it is handed
 * — it throws on a length mismatch, and the length of a rejected candidate is not something to
 * answer a caller with.
 */
export function sameToken(offered: string | null | undefined, expected: string | null | undefined): boolean {
  if (!offered || !expected) return false;
  const left = createHash('sha256').update(offered).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/** The port a canvas URL names, with the protocol's default when it names none. */
function portOf(url: string): number {
  try {
    const parsed = new URL(url);
    return parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80);
  } catch {
    return DEFAULT_CANVAS_PORT;
  }
}

/**
 * The header a program driving the canvas at `url` should send — empty when that board wants none.
 *
 * Empty rather than a refusal, because "no token file" has two ordinary causes and neither is an
 * error here: a board started with the opt-out, and a board from a build older than this one. The
 * request goes out without the header and the server decides.
 */
export function authHeaders(url: string): Record<string, string> {
  const token = readAuthToken(portOf(url));
  return token ? { [TOKEN_HEADER]: token } : {};
}

/**
 * The address a person should be sent to: the board, carrying the token once.
 *
 * This is the whole of the bootstrap. The page reads the parameter, keeps it in `sessionStorage`
 * and takes it out of the address bar, so the secret is in a URL for exactly as long as it takes
 * to arrive — not in the history, not in a bookmark, and not in whatever the reader pastes into
 * an issue when they are asking for help.
 */
export function boardUrlWithToken(url: string): string {
  const token = readAuthToken(portOf(url));
  if (!token) return url;
  try {
    const target = new URL(url);
    target.searchParams.set(LAUNCH_QUERY, token);
    return target.toString();
  } catch {
    return url;
  }
}
