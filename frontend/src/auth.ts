/**
 * The page's half of the board token (#350).
 *
 * The server generates a secret per start and writes it beside its pidfile, and the launcher
 * opens `http://127.0.0.1:PORT/?t=<token>`. Everything after that happens here:
 *
 *   1. the token is read out of the address bar **once**, on the first evaluation of this
 *      module, and kept in `sessionStorage`;
 *   2. it is taken back out of the address bar with `history.replaceState`, so it is not in the
 *      history, not in a bookmark, not in what a reader pastes into an issue, and not in the
 *      `Referer` of anything the page later links to;
 *   3. every same-origin `fetch` this page makes carries it as a header, through a wrapper
 *      installed on `window.fetch` rather than through a change at each of the several dozen
 *      call sites in `App.tsx` and `components/`. A call site that forgot the header would be a
 *      feature that silently stopped working, found by a reader rather than by a compiler.
 *
 * `sessionStorage` rather than `localStorage`: the token is good for this start of this server,
 * and a tab is the right lifetime for it. A reload keeps working, a new tab opened by hand does
 * not, and neither does tomorrow. That is also why this key is not in `./storage.ts`, which is
 * the one door for the eight things the browser *remembers* — a setting a reader chose, kept
 * across upgrades and migrated by name. This is a secret with the lifetime of a tab, and putting
 * it in that map would invite the one change nobody should make to it.
 *
 * **This module must be evaluated before anything that fetches.** `main.tsx` imports it first,
 * and ES modules evaluate in import order, so the wrapper is in place before `App.tsx`'s own
 * module body runs — `WorkspaceDialogs.tsx` calls `fetch` at module scope, which is exactly the
 * case a `useEffect`-time install would miss.
 */

import { LAUNCH_QUERY, TOKEN_HEADER, TOKEN_QUERY, TOKEN_STORAGE_KEY } from '../../src/core/board-token'
import { readDeviceCredential } from './storage'

/**
 * Take the token out of the URL, or off the tab if this is a reload.
 *
 * Storage can throw — a browser with cookies and site data blocked makes `sessionStorage` itself
 * a `SecurityError` — so every touch of it is guarded and the answer falls back to the value in
 * hand. A page that cannot remember the token still works for as long as it is not reloaded,
 * which is better than a page that will not load.
 */
function capture(): string | null {
  let fromUrl: string | null = null
  try {
    const here = new URL(window.location.href)
    fromUrl = here.searchParams.get(LAUNCH_QUERY)
    if (fromUrl) {
      here.searchParams.delete(LAUNCH_QUERY)
      window.history.replaceState(null, '', `${here.pathname}${here.search}${here.hash}`)
    }
  } catch { /* no URL to read, which only happens somewhere this page cannot run anyway */ }

  if (fromUrl) {
    try { window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl) } catch { /* not remembered */ }
    return fromUrl
  }

  try { return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) } catch { return null }
}

const token = capture()

/** The token this tab holds, or null on a board that wants none. */
export function boardToken(): string | null {
  return token
}

/**
 * What this page presents when it asks the board for something: the token, or this device's own.
 *
 * Two credentials, one header, and never both at once. The board token is what the launcher put
 * in the address bar on the machine running the server; the device credential is what an
 * approval on that machine handed to a second one (#504), and a page holds exactly one of them
 * because a page is on exactly one of those machines. The token wins where both somehow exist —
 * it is the narrower of the two, good for this start of this server and no longer.
 *
 * Read on every call rather than captured once, because the device's arrives *during* a page's
 * life: the waiting screen stores it the moment the operator approves, and the reload that
 * follows should not be the thing that makes it take effect.
 */
function presentedCredential(): string | null {
  return token ?? readDeviceCredential()
}

/**
 * The socket URL with the credential on it, because a `WebSocket` handshake carries no headers.
 *
 * A board with no token gets the URL back unchanged, which is what keeps a page from an older
 * server, and a board started with the opt-out, working exactly as they did.
 */
export function withBoardToken(url: string): string {
  const credential = presentedCredential()
  if (!credential) return url
  return `${url}${url.includes('?') ? '&' : '?'}${TOKEN_QUERY}=${encodeURIComponent(credential)}`
}

/**
 * Send the credential on every same-origin request this page makes.
 *
 * Cross-origin is left alone on purpose: this page fetches Excalidraw's fonts from a CDN when
 * the board is not serving them itself, and a secret for `127.0.0.1` has no business travelling
 * to `esm.sh`.
 *
 * Installed unconditionally since #504, where it used to stand down when there was no token. A
 * page that holds nothing *yet* is exactly the page pairing is for, and a wrapper that decided at
 * module scope would leave the newly paired device fetching bare-headed until its next load. The
 * wrapper adds nothing when there is nothing to add, so a board with the token off is untouched.
 */
function install(): void {
  const native = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const credential = presentedCredential()
    if (!credential) return native(input, init)
    let sameOrigin = false
    try {
      const target = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url
      sameOrigin = new URL(target, window.location.href).origin === window.location.origin
    } catch { /* unparseable: treat as somebody else's */ }
    if (!sameOrigin) return native(input, init)

    // Seeded from whichever of the two carries them, so a caller that passed a `Request` keeps
    // its own headers and a caller that passed `init` keeps theirs.
    const headers = new Headers(
      init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined)
    )
    headers.set(TOKEN_HEADER, credential)
    return native(input, { ...init, headers })
  }
}

install()
