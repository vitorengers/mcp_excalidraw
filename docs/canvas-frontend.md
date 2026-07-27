# Canvas in the browser

`frontend/`, React over `@excalidraw/excalidraw` 0.18. One tab per registered project, plus the
`default` board when no registry is configured.

## What it adds on top of Excalidraw

- **Workspace tabs** (`WorkspaceTabs.tsx`) — driven by `GET /api/workspaces`
- **The documentation panel** — `DocsPanel.tsx` holds what it shows, `AnchoredDocsPanel.tsx`
  where it sits; the Docs block card covers both
- **The collapsible image and issue blocks**, both hung off `customData`
- **The terminal** (`TerminalPanel.tsx`) — a shell the server owns, drawn as an overlay over a
  block on the right of the board; the Terminal card has it
- **Autosync** back into the active workspace's store

Everything project-specific lives in `customData`, never in a parallel data structure. That is
the whole reason the blocks survive a round-trip through Excalidraw: the library preserves
`customData` it does not understand, so a shape stays a docs block or an issue block through
every edit, undo and re-render.

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

Two features now drive a real Chrome over the DevTools protocol to answer for themselves —
`scripts/check-board-drafts-browser.mjs` and `scripts/check-terminal-browser.mjs`, both through
`ws` rather than a browser-automation dependency. Everything else in here is still verified by
hand.
