# REST API

`src/server.ts`. 27 routes, and the only surface that is workspace-aware — everything the
browser does, and everything this board was built with, goes through here.

## The routes

| Area | Routes |
|---|---|
| Elements | `GET/POST /api/elements`, `PUT/DELETE /api/elements/:id`, `GET /api/elements/:id`, `GET /api/elements/search`, `DELETE /api/elements/clear`, `POST /api/elements/batch`, `POST /api/elements/from-mermaid`, `POST /api/elements/sync` |
| Project | `GET /api/workspaces`, `GET /api/docs/:key`, `GET /api/library`, `POST /api/issue-block/:id` |
| Project board | `GET /api/project-board`, `POST /api/project-board/move` |
| Files | `GET/POST /api/files`, `GET/DELETE /api/files/:id` |
| Browser round-trips | `POST /api/export/image` and `/result`, `POST /api/viewport` and `/result` |
| Snapshots | `POST/GET /api/snapshots`, `GET /api/snapshots/:name` |
| Health | `GET /`, `GET /health`, `GET /api/sync/status` |

## Two things worth knowing

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

`HOST` can still be set wider; nothing stops that. What does stop is the issue block, which
spawns a process with repository access and refuses to run unless the server is bound to
loopback.
