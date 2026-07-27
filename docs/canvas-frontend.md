# Canvas in the browser

`frontend/`, React over `@excalidraw/excalidraw` 0.18. One tab per registered project, plus the
`default` board when no registry is configured.

## What it adds on top of Excalidraw

- **Workspace tabs** (`WorkspaceTabs.tsx`) — driven by `GET /api/workspaces`
- **The documentation panel** — `DocsPanel.tsx` holds what it shows, `AnchoredDocsPanel.tsx`
  where it sits; the Docs block card covers both
- **The collapsible image and issue blocks**, both hung off `customData`
- **The terminal** (`TerminalPanel.tsx`) — a shell the server owns on a PTY, drawn by xterm.js
  as an overlay over a block on the right of the board; the Terminal card has it
- **Autosync** back into the active workspace's store

Everything project-specific lives in `customData`, never in a parallel data structure. That is
the whole reason the blocks survive a round-trip through Excalidraw: the library preserves
`customData` it does not understand, so a shape stays a docs block or an issue block through
every edit, undo and re-render.

## Opening a board

**The board is decided before anything connects.** `GET /api/workspaces` is awaited first, the
active board is resolved from it, and only then does the socket open — declaring that board.
One socket per load, on the board that is going to be shown.

It used to be the other way round: the socket opened on mount, so it declared `default`, and the
registry then arrived and *switched* it. Every single load paid for a second connection, a second
round of loading, and a canvas that went blank in between — which is what arrived as a bug
report, because a blank canvas reads as data loss.

Which board that is comes from `?workspace=` first, so a board has a URL and two can be open side
by side; then from `localStorage`, so a plain refresh returns where the reader was; then the
first tab. The first two are validated against the registry, so a board that has been removed
from it falls back rather than stranding the canvas on a store nothing writes to.

**Switching boards no longer empties the scene.** The previous board stays up until the new one's
`initial_elements` lands, and autosync is held off for that window — which is what the blanking
was really protecting against.

**Three connection states, not two.** A socket that has never been up is *Connecting*, not
Disconnected; the pill only says Disconnected after four failed retries. Retries are immediate,
then 250 ms doubling to a 5 s ceiling, rather than a flat three seconds. A `ping`/`pong`
heartbeat every ten seconds closes a socket that has stopped answering, so a half-open
connection is noticed instead of read as Connected until TCP gives up.

`scripts/check-refresh-connect-browser.mjs` holds all of this down in a real browser.

## Autosync

The browser is the source of truth for geometry, so it pushes its scene to
`POST /api/elements/sync` on a timer. The server reconciles rather than overwrites — the Sync
reconciliation card has the rule — which is what lets an agent create elements through the API
while a tab is open without them being wiped on the next tick.

The active workspace id rides along on every call, from a ref rather than from React state:
switching tabs while a request is in flight otherwise lands the answer in the wrong store.

## Verification needs a real browser

Three defects here compiled cleanly and did not work: a panel that never opened, a race in tab
startup, and a click landing on the label instead of the box. Type-checking says nothing about
any of them.

Several features now drive a real Chrome over the DevTools protocol to answer for themselves —
`scripts/check-board-drafts-browser.mjs`, `scripts/check-terminal-browser.mjs`,
`scripts/check-terminal-ansi-browser.mjs` and `scripts/check-refresh-connect-browser.mjs` among
them, all through `ws` rather than a browser-automation dependency. Everything else in here is
still verified by hand.
