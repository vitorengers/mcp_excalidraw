# Canvas in the browser

`frontend/`, React over `@excalidraw/excalidraw` 0.18. One tab per registered project, plus the
`default` board when no registry is configured.

## What it adds on top of Excalidraw

- **The bar** — one row of chrome above the canvas: the project tabs
  (`WorkspaceTabs.tsx`, driven by `GET /api/workspaces`) on the left, the controls on the right
- **The documentation panel** — `DocsPanel.tsx` holds what it shows, `AnchoredDocsPanel.tsx`
  where it sits; the Docs block card covers both
- **The collapsible image and issue blocks**, both hung off `customData`
- **The terminal** (`TerminalPanel.tsx`) — a shell the server owns on a PTY, drawn by xterm.js
  as an overlay over a block on the right of the board; the Terminal card has it
- **Autosync** back into the active workspace's store
- **Hide Menus** — a button on the bar that takes Excalidraw's own chrome off the board
- **Restart Server** — the same bar, `POST /api/restart`, behind a confirmation that names
  what a restart costs

Everything project-specific lives in `customData`, never in a parallel data structure. That is
the whole reason the blocks survive a round-trip through Excalidraw: the library preserves
`customData` it does not understand, so a shape stays a docs block or an issue block through
every edit, undo and re-render.

## The bar

One row, `.header`, and the project tabs are its left-hand group rather than a second strip
above it (#261). It was two full-width bands, which cost the canvas about 50px of height for a
row that was mostly empty on both.

- **The tabs flex and scroll.** `.workspace-tabs` has `flex: 1 1 0` and `min-width: 0`, so it
  asks for no width of its own and takes whatever the controls leave, reaching the rest of its
  projects by scrolling sideways. A board with more projects than the row can show scrolls the
  strip; the `+` that adds one is at the end of it.
- **The controls never scroll.** They keep their natural width and wrap onto a second line only
  when the window is narrower than they are.
- **Two type scales, on purpose.** The tabs keep the 2.5x #110 and #144 measured for them; the
  controls are on `--board-controls-scale: 1.25` — 17.5px, up from 14px. Full parity was
  measured and rejected: at 2.5 the controls alone are over 1900px and the row could never hold
  the tabs as well. Both scales are single multipliers, in `WorkspaceTabs.css` and in
  `frontend/index.html`'s style block.
- **No registry means no tabs, not no bar.** `WorkspaceTabs` renders nothing without one, and
  the connection pill, Sync to Backend, Clear Canvas and Restart Server are still there.
- **There is no page title on it.** `<h1>Excalidraw Canvas</h1>` said the same four words on
  every board of every project; the tabs beside it say which board this is. The name is still
  in `<title>`, where a browser tab reads it.

`scripts/check-merged-bar-browser.mjs` measures all of it in a real browser, in both themes.

## Restarting the server from the board

`Restart Server`, at the right-hand end of the bar, opens a confirmation naming what a restart
costs — terminal sessions close, implementations in flight become `interrupted` and are
re-derived from git, the boards themselves survive, and the page reconnects on its own. Then it
posts to `/api/restart` and waits for a **different pid** to answer `/health`, which is the only
thing that distinguishes a server that restarted from one that never went.

The button is disabled when the page is not on loopback, because the route is refused there.
The server side of it — and why a supervisor outside the process tree is the only way to do
this — is in [rest-api.md](rest-api.md) and `src/core/restart-supervisor.ts`.

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

**A board switched away from stays live.** Its socket is kept and goes on applying what
arrives to a copy of that board's scene; coming back paints the copy and adopts the socket back,
in the same turn as the click. No reconnect, no `GET /api/elements`, and the pill never leaves
*Connected*. Nothing was ever *lost* before this — a shell outlives the socket watching it and
replays its scrollback on connect — but every return paid for a redraw, which is the whole of
#173: "I dont want to change to a tab and start loading."

Two decisions the issue left open, both answerable only one way once written down:

- **Visited boards only, four of them.** Every *registered* board would be a socket and a poll
  per project whether or not anyone had opened it. Opening a board is the reader saying they are
  working on it; `WARM_BOARD_LIMIT` bounds what the page keeps a second copy of, and the board
  waited on longest goes cold past it — which costs that board nothing but the reconnect it used
  to pay every time.
- **A background board does not autosync, and does not poll.** It has no scene on screen to
  push and nobody is reading its mirror. The board in front stays the only one writing anything.

What is copied is the **scene**, not the store: the mirror's cards and the terminal's blocks are
derived and are in no store at all, so a copy of the store would come back missing exactly the
things that take a `gh` call and a shell to put back. A board mid-switch is *not* kept — the
socket already names the board being entered while the canvas still draws the one before it, and
a copy taken then would file one project's shapes under another.

**A warm socket is listening, not watching**, and the server is told which. `clientsWatching`
is what lets an export or a viewport request for a board with no browser on it be refused at
once instead of waiting out its timeout, and a socket held open for a board nobody is looking at
would otherwise answer for it. The client sends `{ type: "watching", active }` on the way out and
on the way back; a socket that never says is watching, which is every other client.
`scripts/check-warm-board-browser.mjs` counts the sockets and the requests from inside the page.

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

## The scene waits for its fonts

Excalidraw does not keep the `width` a text element was authored with. Every element this app
puts on the canvas goes through `convertToExcalidrawElements`, whose `text` branch calls
`newTextElement`, and that discards the incoming width and re-measures the string with a
`CanvasRenderingContext2D` — in whatever font the browser has at that instant. On a cold profile
that instant is before any webfont has arrived, so the width recorded is the *fallback* font's,
which is narrower. When Excalifont lands, `Fonts.onLoaded` invalidates the shape cache and
repaints, but it never re-measures: the glyphs are now wider than the width the element is
clipped to, and the tail of every label is cut. Nothing later fixes it — these are authored
elements, and nothing redraws them (#234).

So `canvas-fonts.ts` holds the scene until the fonts it is written in can be measured, and
`handleWebSocketMessage` and `loadExistingElements` — the two ways a board first reaches the
canvas — await it before converting anything. The wait is per family and per character: only the
`woff2` subsets the incoming text actually needs are asked for, which matters because Excalifont
alone is split across seven files by `unicodeRange` and `Especificação` is not in the same one as
`Especificacao`. It gives up after six seconds and draws anyway; a label a character short is
worth having, a canvas that never appears is not.

**`document.fonts.check` is not what it waits on, and cannot be.** For a family nothing has
registered it answers `true` — the system font substituted for it is by definition already
loaded — so on the one load where the answer matters, before Excalidraw has added its
`FontFace`s, it says yes to every font in the world. What is used instead is the `FontFace`
objects themselves plus a measurement: a family being substituted measures exactly the same as a
family that does not exist, and a real load moves that number.

This is a different clipping from the one the mirror shows on first paint. A mirror label is
*derived*, so the next 20-second poll redraws and re-measures it with the font in place and it
settles by itself. An authored element has nothing that would.

**The fonts come from this server, not from a CDN.** `frontend/index.html` sets
`window.EXCALIDRAW_ASSET_PATH = '/assets/'`, which is the mount `src/server.ts` already had over
`node_modules/@excalidraw/excalidraw/dist/prod/fonts`. Without it Excalidraw's
`ExcalidrawFontFace.createUrls` has one source and it is
`https://esm.sh/@excalidraw/excalidraw@<version>/dist/prod/` — which is why `GET /fonts/…woff2`
against this server answered 404 while the `FontFace` still reached `loaded`: the file was never
coming from here. A board on a machine with no internet could not draw its own font at all. The
CDN stays on as the second `src()` of every face, so a build missing that directory degrades to
what it did before rather than losing the font. In dev, `vite.config.js` proxies `/assets/fonts`
across to the canvas server for the same reason.

`scripts/check-canvas-fonts-browser.mjs` drives a cold Chrome over all of it, with `esm.sh`
blocked in one scenario and every `woff2` held back 2.5 s in the other.

## Verification needs a real browser

Three defects here compiled cleanly and did not work: a panel that never opened, a race in tab
startup, and a click landing on the label instead of the box. Type-checking says nothing about
any of them.

Several features now drive a real Chrome over the DevTools protocol to answer for themselves —
`scripts/check-board-drafts-browser.mjs`, `scripts/check-terminal-browser.mjs`,
`scripts/check-terminal-ansi-browser.mjs` and `scripts/check-refresh-connect-browser.mjs` among
them, all through `ws` rather than a browser-automation dependency. Everything else in here is
still verified by hand.
