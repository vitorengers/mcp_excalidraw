/**
 * Who is allowed to talk to this server.
 *
 * Every other guard here tests the *bind address* — `LOOPBACK_ADDRESSES.includes(HOST)` — and
 * that is the wrong question for a browser. A page at any origin, running in the operator's
 * own browser, reaches loopback exactly as the board does; `app.use(cors())` then supplied
 * `origin: '*'`, so one cross-origin `fetch` to `/api/terminal` was a shell running as the
 * operator with a readable answer.
 *
 * **CORS headers alone would not have fixed it.** A cross-origin `fetch` with
 * `mode: 'no-cors'` still executes on this side; the browser only withholds the *response*
 * from the attacker. Starting the shell is the damage. So this is a gate that refuses with
 * 403 before the route runs, not a header that decorates the reply.
 *
 * Two headers are checked, because neither is sufficient alone:
 *
 * - `Origin` names the page that made the request. A browser always sends it on a
 *   cross-origin request and cannot be talked out of it, so it is what stops an ordinary
 *   malicious page. It is absent on non-browser callers — the CLI, the MCP server and the
 *   check scripts — and absent is therefore allowed.
 * - `Host` names the authority the browser resolved. An attacker who points
 *   `board.evil.example` at 127.0.0.1 makes their page *same-origin* with this server, so no
 *   `Origin` check can see them. Pinning `Host` to the authority the board is actually served
 *   on is what closes DNS rebinding.
 */

import { settingName } from './settings.js';

export interface OriginVerdict {
  ok: boolean;
  /** Why the request was refused, phrased for the operator rather than the caller. */
  reason?: string;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The authorities a request may name, built from the address this server was told to bind.
 *
 * A board reached as `localhost:3737` and the same board reached as `127.0.0.1:3737` are the
 * same board and both are in here, because which one the operator typed is not something this
 * server gets to decide. `extra` is the escape hatch for an alias or a reverse proxy, and it
 * is the only reason this function takes a third argument.
 */
export function allowedAuthorities(host: string, port: number, extra?: string): Set<string> {
  const authorities = new Set<string>();
  const add = (hostname: string) => {
    if (!hostname) return;
    authorities.add(`${hostname}:${port}`.toLowerCase());
  };

  for (const hostname of LOOPBACK_HOSTNAMES) add(hostname);
  // A server deliberately bound somewhere else still answers for that name.
  add(host);

  for (const entry of (extra ?? '').split(',')) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    // An entry may carry its own port, or inherit this server's.
    authorities.add(trimmed.includes(':') ? trimmed : `${trimmed}:${port}`);
  }

  return authorities;
}

function authorityOf(value: string | undefined, port: number): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === 'null') return null;
  try {
    // An Origin is a URL; a Host is bare. `new URL` handles the first, and the second is
    // already the shape we compare.
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`http://${trimmed}`);
    return url.port ? `${url.hostname}:${url.port}` : `${url.hostname}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Whether a request may proceed.
 *
 * `origin` absent means the caller is not a browser: the CLI, the MCP server, `curl` and the
 * ~130 check scripts all land here, and refusing them would break every one of them without
 * defending against anything — a program that can set headers can set any header it likes.
 * The defence is against a *page*, which cannot.
 */
export function verifyOrigin(
  headers: { origin?: string; host?: string },
  authorities: Set<string>,
  port: number,
): OriginVerdict {
  const expected = [...authorities].join(', ');

  const hostAuthority = authorityOf(headers.host, port);
  if (headers.host && (!hostAuthority || !authorities.has(hostAuthority))) {
    return {
      ok: false,
      reason:
        `This board answers for ${expected}, and the request named ${headers.host}. ` +
        'A name that resolves here but is not this board is how DNS rebinding reaches a ' +
        `local server; if this is a real alias or a proxy, add it to ${settingName('ALLOWED_HOSTS')}.`,
    };
  }

  if (!headers.origin) return { ok: true };

  const originAuthority = authorityOf(headers.origin, port);
  if (!originAuthority || !authorities.has(originAuthority)) {
    return {
      ok: false,
      reason:
        `A page at ${headers.origin} tried to reach this board, which answers for ${expected}. ` +
        'Only the board\'s own page may drive it.',
    };
  }

  return { ok: true };
}
