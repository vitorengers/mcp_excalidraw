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
 * not, and neither does tomorrow.
 *
 * **This module must be evaluated before anything that fetches.** `main.tsx` imports it first,
 * and ES modules evaluate in import order, so the wrapper is in place before `App.tsx`'s own
 * module body runs — `WorkspaceDialogs.tsx` calls `fetch` at module scope, which is exactly the
 * case a `useEffect`-time install would miss.
 */

import { LAUNCH_QUERY, TOKEN_HEADER, TOKEN_QUERY, TOKEN_STORAGE_KEY } from '../../src/core/board-token'

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
 * The socket URL with the token on it, because a `WebSocket` handshake carries no headers.
 *
 * A board with no token gets the URL back unchanged, which is what keeps a page from an older
 * server, and a board started with the opt-out, working exactly as they did.
 */
export function withBoardToken(url: string): string {
  if (!token) return url
  return `${url}${url.includes('?') ? '&' : '?'}${TOKEN_QUERY}=${encodeURIComponent(token)}`
}

/**
 * Send the token on every same-origin request this page makes.
 *
 * Cross-origin is left alone on purpose: this page fetches Excalidraw's fonts from a CDN when
 * the board is not serving them itself, and a secret for `127.0.0.1` has no business travelling
 * to `esm.sh`.
 */
function install(): void {
  if (!token) return
  const native = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
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
    headers.set(TOKEN_HEADER, token)
    return native(input, { ...init, headers })
  }
}

install()
