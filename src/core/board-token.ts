/**
 * The four names the two halves of the board token have to agree on.
 *
 * A module of its own, with no imports at all, because the frontend is one of the halves:
 * `frontend/src/auth.ts` reads these from here the way `App.tsx` reads `core/board-sections`,
 * and it could not import `core/auth-token.ts`, which is `fs`, `crypto` and the settings layers.
 * Spelling any of them twice would be a header the page sends and the server does not read,
 * which compiles perfectly and produces a board where nothing works.
 *
 * What each one is for is in [auth-token.ts](auth-token.ts); this file is only the strings.
 */

/** The request header a program sends the token on. Lowercase: Node lowercases every name. */
export const TOKEN_HEADER = 'x-vibemaxxing-token';

/** The query parameter a socket sends it on, and any caller may. */
export const TOKEN_QUERY = 'token';

/** The query parameter the launcher puts in the address bar, for the page to consume once. */
export const LAUNCH_QUERY = 't';

/** Where the page keeps it for the life of the tab. `sessionStorage`, never `localStorage`. */
export const TOKEN_STORAGE_KEY = 'vibemaxxing.board-token';
