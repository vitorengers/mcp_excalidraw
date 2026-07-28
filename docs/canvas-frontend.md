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
- **Hide Menus** — a header button that takes Excalidraw's own chrome off the board

Everything project-specific lives in `customData`, never in a parallel data structure. That is
the whole reason the blocks survive a round-trip through Excalidraw: the library preserves
`customData` it does not understand, so a shape stays a docs block or an issue block through
every edit, undo and re-render.

## Hiding Excalidraw's own menus

`Hide Menus`, beside `Clear Canvas`, takes away the three pieces of chrome Excalidraw draws over
the board: the hamburger at the top left, the properties island that appears beside a selected
shape, and the toolbar across the top. Pressing it again brings them back. The setting is one per
browser, kept in `localStorage` under `excalidraw-canvas-chrome` the way the theme is, so it
holds across a reload and is the same on every project tab — and never reaches the store or
anybody else's tab, because it is what one reader is looking at rather than board state.

**Nothing here uses `viewModeEnabled`.** Selecting and drawing keep working with the chrome
hidden; the tools stay reachable by their keyboard shortcuts. View mode turns a main-button
press into a pan, and this board opens the documentation panel — and the implement queue — off
`selectedElementIds`, so it would be an off switch for the product rather than a display setting.
`zenModeEnabled` was the other candidate and only moves one of the three.

Excalidraw offers no prop that removes the hamburger, so the mechanism is **CSS over its own
class names** — `App-menu_top__left` and `shapes-section` — keyed off `data-chrome` on the app
root, in `frontend/index.html`'s style block, where this app already reaches into Excalidraw's
styling. The library trigger and the footer stay: they were not named, and the library trigger is
how blocks reach a board. It shares a three-column grid with the two that go, so it is pinned to
its column rather than left to slide left into the space they vacate.

**Two things are unreachable while the chrome is hidden**, accepted rather than solved: the
light/dark switch lives in the hamburger, as do Export and Save as image. Showing the menus again
is how you reach them.

`scripts/check-chrome-toggle-browser.mjs` drives a real Chrome over all of it.

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

**So the active board and the board on screen disagree for the length of a reconnect**, and
`sceneWorkspaceRef` is the second one. `activeWorkspaceRef` names the board being entered from
the moment the tab is clicked, because that is what every request has to carry;
`sceneWorkspaceRef` moves on when the new scene actually lands. Anything derived from what is
*drawn* reads the second one. Reading the first is #156: the terminal cached where each block
sat, was told the new board's name while the old board's blocks were still on the canvas, and
put one project's terminal on another project's board.

**Each board keeps its own camera.** There is one viewport for the page and there always was —
the Excalidraw element carries no React key, so it is never remounted and a switch swaps the
scene underneath it. `scrollX`, `scrollY` and `zoom` therefore carried straight over from the
board you left, which reads as the tabs being wired together, and on boards whose content sits
at different coordinates it reads worse: the second board opens on empty canvas, as if its
drawing were gone. `boardViewportsRef` writes each board's down on the way out and puts it back
on the way in; a board arrived at for the *first* time is fitted to its own content instead.
Restoring is a restore, not a re-fit — a board left looking at nothing comes back looking at
nothing. `scripts/check-workspace-viewport-browser.mjs` holds it down.

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
