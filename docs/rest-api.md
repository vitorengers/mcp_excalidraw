# REST API

`src/server.ts`. 52 routes, and the only surface that is workspace-aware — everything the
browser does, and everything this board was built with, goes through here.

The table below is the whole set, one row per route. It used to be a summary of thirty, under a
heading that said twenty-seven, while the server answered on fifty;
`scripts/check-docs-counts.mjs` now reads the routes out of `src/server.ts` and fails when one of
them is missing from here.

## Elements

The canvas store, one `Map` per workspace — see [element-store.md](element-store.md).

| Route | What it does |
|---|---|
| `GET /api/elements` | Every element in this workspace |
| `POST /api/elements` | Create one |
| `GET /api/elements/:id` | Read one |
| `PUT /api/elements/:id` | Update one |
| `DELETE /api/elements/:id` | Delete one |
| `DELETE /api/elements/clear` | Empty the store. Declared before `:id`, so `clear` is never read as an element id |
| `GET /api/elements/search` | Filter by type, bounding box and arbitrary fields |
| `POST /api/elements/batch` | Create many, ids preserved |
| `POST /api/elements/from-mermaid` | Hand a Mermaid diagram to the browser to render |
| `POST /api/elements/sync` | The browser's merge back into the store — [sync-reconciliation.md](sync-reconciliation.md) |

## Workspaces

One project per board — see [workspaces.md](workspaces.md).

| Route | What it does |
|---|---|
| `GET /api/workspaces` | The registry, reloaded per request |
| `POST /api/workspaces` | Append a project to the registry (loopback only) |
| `PUT /api/workspaces/order` | Permute the registry, which is the order of the tabs (loopback only) |
| `GET /api/workspaces/:id/config` | That project's `board.config.json`, as it is on disk |
| `PUT /api/workspaces/:id/config` | Write it back, round-tripped (loopback only) |
| `GET /api/fs/directories` | List folders, for the picker the browser cannot implement (loopback only) |

## Issue blocks

An observation on the canvas becomes a GitHub issue — see [issue-block.md](issue-block.md).
Every route here shells out to `gh` holding the user's credentials, so every route here is
loopback only.

| Route | What it does |
|---|---|
| `POST /api/issue-block/:id` | Run the research agent and open the issue |
| `POST /api/issue-block/:id/adopt` | Attach an issue that already exists, without creating one |
| `DELETE /api/issue-block/:id` | Forget the run, so the block can be tried again |
| `GET /api/issue-block/:id/issue` | The issue behind a block, read live rather than copied onto it |
| `GET /api/issue` | The issue behind a *mirrored card*, which has no element id, plus what is known about implementing it |
| `POST /api/issue/comment` | Add a comment — the one way to answer an issue agent's open questions without leaving the board |
| `POST /api/issue/recreate` | Research the issue again and rewrite it in place, while its card is still in Todo |
| `GET /api/issue/recreate` | What that run has done so far, with no `gh` behind it |

## Implementations

The implement agent, its worktree and the queue that feeds it — see
[project-board.md](project-board.md).

| Route | What it does |
|---|---|
| `POST /api/issue-block/:id/implement` | Implement the issue on a block |
| `POST /api/implement` | Implement an issue by URL, for a mirrored card the server has never seen; `resume: true` continues an interrupted attempt |
| `DELETE /api/issue-block/:id/implement` | Reset a block's record, refused while its run is alive |
| `GET /api/implement` | One record by `?url=`, or every record for the workspace, with the concurrency cap and the queue state |
| `DELETE /api/implement` | The same reset, by URL |
| `POST /api/implement/queue` | Turn this workspace's queue on or off (loopback only, and off unless implementing is enabled) |

## Project board mirror

| Route | What it does |
|---|---|
| `GET /api/project-board` | The GitHub project, read live through `gh` (loopback only) |
| `POST /api/project-board/move` | Move a card to another column — this one writes to GitHub (loopback only) |

## Terminal

Shells on the canvas — see [terminal.md](terminal.md). Opt in with `EXCALIDRAW_TERMINAL`;
loopback only, and capped per board.

| Route | What it does |
|---|---|
| `POST /api/terminal` | Open a session |
| `GET /api/terminal` | The sessions this workspace holds |
| `POST /api/terminal/input` | Write bytes to one |
| `POST /api/terminal/resize` | Tell the pty its new size |
| `DELETE /api/terminal` | End one |

## Documents, library and files

| Route | What it does |
|---|---|
| `GET /api/docs/:key` | The markdown behind a `customData.docKey` — [docs-block.md](docs-block.md) |
| `GET /api/library` | The environment-wide `.excalidrawlib` plus the project's own — [shared-library.md](shared-library.md) |
| `GET /api/files` | The image payloads *this* board references |
| `GET /api/files/:id` | One of them |
| `POST /api/files` | Add one |
| `DELETE /api/files/:id` | Remove one |

## Browser round-trips

| Route | What it does |
|---|---|
| `POST /api/export/image` | Ask the open tab to render a PNG or SVG |
| `POST /api/export/image/result` | The tab answering back |
| `POST /api/viewport` | Ask the open tab to move the camera |
| `POST /api/viewport/result` | The tab answering back |

## Snapshots and health

| Route | What it does |
|---|---|
| `POST /api/snapshots` | Save the scene under a name |
| `GET /api/snapshots` | List the names |
| `GET /api/snapshots/:name` | Restore one |
| `GET /` | The built frontend |
| `GET /health` | Liveness, plus the `pid` of whatever is actually answering |
| `GET /api/sync/status` | What the store and the connected browsers currently hold |

## Three things worth knowing

**Every route resolves its own workspace**, through `workspaceIdFrom()` — `?workspace=`, a body
field, or the `x-workspace-id` header. Omitting it is not an error; it means the `default`
store.

**`GET /api/files` answers with one board's files.** The store behind it is not per-board — a
file is content-addressed by id, and two boards may legitimately reference the same one — so the
scoping is by reference: the ids the workspace's own image elements and issue blocks name. It
used to hand back every dataURL the process held, for every board, on every page load and every
socket connect, which on a board full of screenshots is megabytes fetched to draw a canvas that
needed none of them.

**The `/result` routes are the browser answering back.** Exporting an image or reading the
viewport needs a real Excalidraw instance, which only exists in an open tab. The server asks over
the WebSocket, the browser does the work and POSTs the answer to the matching `/result` route.
With no tab open, those calls have nobody to ask.

## No authentication

There is none. `HOST` defaults to `127.0.0.1` — IPv4 loopback, not `::` — and startup refuses
when another loopback listener already holds the port, which is what would otherwise leave two
canvas servers splitting state across IPv4 and IPv6. `scripts/check-local-bind.mjs` pins both
down.

`HOST` can still be set wider; nothing stops that. What does stop is every route marked
*loopback only* above: each of them either spawns a process holding your `gh` credentials, writes
to GitHub, or reaches your filesystem, and each refuses with 403 rather than doing so for a
caller that arrived over the network.
