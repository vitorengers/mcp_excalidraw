# REST API

`src/server.ts`. 62 routes, and the only surface that is workspace-aware — everything the
browser does, and everything this board was built with, goes through here.

The table below is the whole set, one row per route. It used to be a summary of thirty, under a
heading that said twenty-seven, while the server answered on fifty;
`scripts/check-docs-counts.mjs` now reads the routes out of `src/server.ts` and fails when one of
them is missing from here.

## Every route here needs the board's token

`/api` answers **401** to a request that does not carry it, and so does the WebSocket upgrade.
The server writes the secret to `server-<port>.token` in its state directory at startup, owner
only ([configuration.md](configuration.md)), and a caller sends it either as the
`X-VibeMaxxing-Token` header or as `?token=` — the second because a browser's `WebSocket`
constructor has nowhere to put a header. `GET /` and `GET /health` are outside the gate, so that
a page can load before it has read anything and so that a tool can find out what is on a port.
`POST /api/pair/request` and `GET /api/pair/status` are outside it for the same shape of reason
— asking for a credential is what they are, so requiring one would be a circle — and they are
the only two routes under `/api` that are. See [Pairing a second machine](#pairing-a-second-machine).
[SECURITY.md](SECURITY.md) is what the secret is for and what it does not do.

```bash
curl -H "X-VibeMaxxing-Token: $(cat "$XDG_STATE_HOME/excalidraw-canvas/server-3737.token")" \
  http://127.0.0.1:3737/api/elements
```

The CLI and the MCP server read that file themselves, so nothing below needs a flag.

## Elements

The canvas store, one `Map` per workspace — see [element-store.md](element-store.md).

| Route | What it does |
|---|---|
| `GET /api/elements` | Every element in this workspace (loopback only) |
| `POST /api/elements` | Create one (loopback only) |
| `GET /api/elements/:id` | Read one (loopback only) |
| `PUT /api/elements/:id` | Update one (loopback only) |
| `DELETE /api/elements/:id` | Delete one (loopback only) |
| `DELETE /api/elements/clear` | Empty the store, having first copied it beside the board's saved state — the path is `backup` in the response, or null if there was nothing to copy. Declared before `:id`, so `clear` is never read as an element id (loopback only) |
| `GET /api/elements/search` | Filter by type, bounding box and arbitrary fields (loopback only — with no query at all it is `GET /api/elements` by another name) |
| `POST /api/elements/batch` | Create many, ids preserved (loopback only) |
| `POST /api/elements/from-mermaid` | Hand a Mermaid diagram to the browser to render (loopback only) |
| `POST /api/elements/sync` | The browser's merge back into the store — [sync-reconciliation.md](sync-reconciliation.md) (loopback only) |

## Workspaces

One project per board — see [workspaces.md](workspaces.md).

| Route | What it does |
|---|---|
| `GET /api/workspaces` | The registry, reloaded per request (loopback only — it is every project's absolute path) |
| `POST /api/workspaces` | Append a project to the registry (loopback only) |
| `DELETE /api/workspaces/:id` | Drop that entry — the folder and its `board.config.json` are left alone, and so is the saved board unless `?board=delete` (loopback only) |
| `PUT /api/workspaces/order` | Permute the registry, which is the order of the tabs (loopback only) |
| `GET /api/workspaces/:id/config` | That project's `board.config.json`, as it is on disk (loopback only) |
| `PUT /api/workspaces/:id/config` | Write it back, round-tripped (loopback only) |
| `GET /api/fs/directories` | List folders, for the picker the browser cannot implement (loopback only) |

## Issue blocks

An observation on the canvas becomes a GitHub issue — see [issue-block.md](issue-block.md).
Every route here that shells out to `gh` does so holding the user's credentials, and each of
those is marked below. The two that are not marked read this process's own memory and answer
wherever the server is bound; see [SECURITY.md](SECURITY.md#where-it-listens) for what that is
worth to a caller on the network.

| Route | What it does |
|---|---|
| `POST /api/issue-block/:id` | Run the research agent and open the issue (loopback only) |
| `POST /api/issue-block/:id/adopt` | Attach an issue that already exists, without creating one (loopback only) |
| `DELETE /api/issue-block/:id` | Forget the run, so the block can be tried again (loopback only) |
| `GET /api/issue-block/:id/issue` | The issue behind a block, read live rather than copied onto it (loopback only) |
| `GET /api/issue-block/:id/run` | What that block's research run has spent, polled while it is going. Reads memory, so it is the one route here with no `gh` behind it — and therefore one of the two here with no bind guard on it either |
| `GET /api/issue` | The issue behind a *mirrored card*, which has no element id, plus what is known about implementing it (loopback only) |
| `POST /api/issue/comment` | Add a comment — the one way to answer an issue agent's open questions without leaving the board (loopback only) |
| `POST /api/issue/recreate` | Research the issue again and rewrite it in place, while its card is still in Todo (loopback only) |
| `GET /api/issue/recreate` | What that run has done so far, with no `gh` behind it, and no bind guard either |

## Implementations

The implement agent, its worktree and the queue that feeds it — see
[project-board.md](project-board.md).

| Route | What it does |
|---|---|
| `POST /api/issue-block/:id/implement` | Implement the issue on a block (loopback only) |
| `POST /api/implement` | Implement an issue by URL, for a mirrored card the server has never seen; `resume: true` continues an interrupted attempt (loopback only) |
| `DELETE /api/issue-block/:id/implement` | Reset a block's record, refused while its run is alive. No bind guard |
| `GET /api/implement` | One record by `?url=`, or every record for the workspace, with the concurrency cap and the queue state. No bind guard — the `queue` half is dropped off loopback, the records are not |
| `DELETE /api/implement` | The same reset, by URL. No bind guard |
| `POST /api/implement/queue` | Turn this workspace's queue on or off (loopback only, and off unless implementing is enabled) |

## Project board mirror

| Route | What it does |
|---|---|
| `GET /api/project-board` | The GitHub project, read live through `gh` (loopback only) |
| `POST /api/project-board/move` | Move a card to another column — this one writes to GitHub (loopback only) |
| `GET /api/github-status` | Whether `gh` is installed and logged in, per board, behind a short memo (loopback only — it answers with the login and the token's scopes) |

`GET /api/project-board` answers three refusals, and they are three because the canvas does
different things with them:

| Status | `reason` | What the canvas does |
|---|---|---|
| 404 | `no-project` / `no-workspace` | Draws nothing, says nothing. Most boards. |
| 422 | `bad-project-url` | Says so: somebody wrote a `githubProject` and it is not a project URL |
| 502 | — | Says so, carrying `gh`'s own stderr |

The 404 and the 422 were one answer until #317, which is why a typo in a project URL produced
the silence meant for a board that never had one.

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
| `GET /api/docs/:key` | The markdown behind a `customData.docKey` — [docs-block.md](docs-block.md) (loopback only) |
| `GET /api/library` | The environment-wide `.excalidrawlib` plus the project's own — [shared-library.md](shared-library.md) (loopback only) |
| `GET /api/files` | The image payloads *this* board references (loopback only) |
| `GET /api/files/:id` | One of them (loopback only) |
| `POST /api/files` | Add one (loopback only) |
| `DELETE /api/files/:id` | Remove one (loopback only) |

## Browser round-trips

Every route here is loopback only, the `/result` pair included. The tab that would answer cannot
open its socket off loopback at all, so nothing is lost by refusing them there; what is refused is
a caller resolving somebody else's pending export by guessing a request id.

| Route | What it does |
|---|---|
| `POST /api/export/image` | Ask the open tab to render a PNG or SVG |
| `POST /api/export/image/result` | The tab answering back |
| `POST /api/viewport` | Ask the open tab to move the camera |
| `POST /api/viewport/result` | The tab answering back |

## Pairing a second machine

| Route | What it does |
|---|---|
| `POST /api/pair/request` | A device with no credential asks to pair, proposing a name for itself; answers a `requestId` and a **code**, and nothing secret. Bounded — 429 for a second live request from the same address or once the board is holding its ceiling of eight, 400 for a request that proposes no name |
| `GET /api/pair/status` | What became of a `requestId`: `pending`, or `approved` **once**, carrying the device's `credential` — the `id.secret` string `verifyDevice` takes. Every poll after that answers `unknown`, which is also what a `requestId` nobody issued answers |
| `GET /api/pair/pending` | Every live request, with the code, the name it proposed, the `Host` it reached this board under and the address it arrived from (loopback **caller** only) |
| `POST /api/pair/approve` | Approve one of them by `requestId` **and** `code`; `addDevice` mints the secret and writes the record, and the answer carries neither (loopback **caller** only) |

The gesture is: open the board on the second machine, read the code off it, approve it on the
machine running the board. The rules that make that a gesture rather than a hole are in
`src/core/pairing.ts` — the code is compared rather than merely displayed, so the operator is
choosing between requests instead of confirming that one exists; the credential is handed over on
exactly one poll and the record dies with it; and the open routes are bounded, because the whole
of their effect is a row on the operator's screen.

**Nothing here mints.** `src/core/pairing.ts` decides *when* a device is approved and
`src/core/device-registry.ts` is what makes the secret and writes the record — it is handed to
the desk as `mint` rather than imported, so a check can drive the expiry and the ceiling without
pairing devices into the state directory of whoever ran it. The registry throws rather than
warning if it cannot write, and it throws before the pending record is touched: a board whose
state directory has gone read-only answers 500 and leaves the request still approvable.

**Loopback here is the caller, not the bind.** `notTheHost()` reads `req.socket.remoteAddress`
and nothing else — `X-Forwarded-For` is deliberately not consulted, because a header any caller
can set would turn the one property of a request nobody can forge into one everybody can, and a
remote caller would approve itself by asking politely. A reverse proxy reaches this server *on*
loopback, so a proxied board is unaffected.

The two open routes are also outside the `Host` pin, and only those two: a device that has not
been approved yet reaches this board under a name it does not answer for, which is what pairing
*is*. The pending record carries that name for the operator to recognise rather than pinning it.
`Origin`, when a browser sends one, still has to name the same authority as `Host`, so a page at
some other origin cannot put rows on the operator's screen.

`scripts/check-pairing-handshake.mjs` drives the whole exchange, including an approval attempted
from a genuinely non-loopback socket.

## Snapshots and health

| Route | What it does |
|---|---|
| `POST /api/snapshots` | Save this workspace's scene under a name (loopback only) |
| `GET /api/snapshots` | List the names this workspace has taken (loopback only) |
| `GET /api/snapshots/:name` | Read one back, from the workspace that took it (loopback only) |
| `GET /` | The built frontend |
| `GET /health` | Liveness, plus the `pid` of whatever is actually answering, the `version` it was built from, the `platform` it is answering from, how many issues it is `implementing`, and what the startup preflights found: `agents` per role and environment, and `gh` (`resolved` plus a version number — never the login, the scopes or stderr, which this route is not authenticated enough for) |
| `POST /api/restart` | Replace this server with a new one on the same port (loopback only) |
| `GET /api/sync/status` | What the store and the connected browsers currently hold |
| `GET /api/agent-limits` | What each coding-agent environment on this machine has spent (loopback only) — [agent-limits.md](agent-limits.md) |

Snapshots are **in memory and per workspace**, and both halves of that matter. They die with the
process, so they are not the thing that makes a board recoverable — the copy
`DELETE /api/elements/clear` writes to disk is. And they are keyed by name *within* a board since
#345: a snapshot called `before` taken on one project used to be read, and silently overwritten,
from another, which made the safety net the most dangerous thing in the room for the caller most
likely to reach for it.

### `POST /api/restart`

A server cannot restart itself: whatever runs the kill dies with the kill, and the port then
goes to whatever auto-starts first. That has happened here — a terminal block was asked to
restart the board, and an MCP server attached to an editor supplied the replacement, holding
none of the board's environment (see [running.md](running.md) and
`scripts/check-health-identity.mjs`).

So the route does two things and then leaves. It hands a **supervisor** — a detached process
outside this one's tree, `src/core/restart-supervisor.ts`, carrying `{ ...process.env }` — the
identity the replacement must have, and answers before it exits so the board knows the request
was taken. The supervisor waits for the old pid to go, waits for the port to actually free (a
server that cannot bind exits quietly, [trap-stale-server.md](trap-stale-server.md)), starts
`node dist/server.js`, and then verifies `/health` reports the *new* pid **and** the same
`workspaces`, `terminal` and `agents` the old one had — never `status: healthy` alone, which is
exactly what the stand-in said. It writes what happened to `restart-<port>.log` beside the
pidfile, because the process that asked is deliberately gone by then.

It restarts the build that is on disk. It does not run a build.

It also restarts the build *this* server came from — `dist/server.js` is resolved relative to the
dying process's own module URL — which is right for a board restarting itself and wrong for a
canvas left behind by a previous release. Replacing that one is the CLI's `restart`
([cli.md](cli.md)), which stops the old server and starts one from the install that ran the
command.

`scripts/check-restart-route.mjs` starts a configured server, restarts it through the route and
asserts all of that, including the 403 off loopback.

## Three things worth knowing

**Every route resolves its own workspace**, through `workspaceIdFrom()` — `?workspace=`, a body
field, or the `x-workspace-id` header. Omitting it is not an error; it means the `default`
store.

The three spellings are interchangeable, and on one route that used to be untrue.
`GET /api/elements/search` reads whatever query parameter it does not recognise as an
exact-match filter over element fields, so `?workspace=X` chose the right board and then asked
it for elements carrying a `workspace` property — which none has, so a full board answered
empty while `x-workspace-id: X` answered all of it (#457). That route now excludes the names the
transport has already spent, `workspace` and `token`, from its filter set; neither is a property
an element can have, so nothing that could ever have matched is lost.

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

## Where it listens, and what that decides

This section said **No authentication** and opened with *there is none* until #350 put the token
above in front of `/api`. What has not changed is that the token is one shared secret and the
bind is a separate answer underneath it, so both are still worth reading here.

`HOST` defaults to `127.0.0.1` — IPv4 loopback, not `::` — and startup refuses when another
loopback listener already holds the port, which is what would otherwise leave two canvas servers
splitting state across IPv4 and IPv6. `scripts/check-local-bind.mjs` pins both down.

`HOST` can still be set wider; nothing stops that. What does stop is every route marked
*loopback only* above, each of which refuses with 403 rather than answering a caller that
arrived over the network. Three kinds of route carry that mark, and the second was decided in
#366 and the third in #456:

- the ones that spawn a process holding your `gh` credentials, write to GitHub, or reach your
  filesystem;
- **every read of board contents** — `GET /api/elements`, `/api/elements/search`,
  `/api/elements/:id`, `/api/files`, `/api/files/:id`, `/api/docs/:key`, `/api/library`,
  `/api/snapshots` and `/api/snapshots/:name`, plus the **WebSocket upgrade**, which sends the
  whole scene as `initial_elements` the moment it is accepted;
- **and every write of them** — `POST /api/elements`, `PUT /api/elements/:id`,
  `DELETE /api/elements/:id`, `DELETE /api/elements/clear`, `/api/elements/batch`,
  `/api/elements/from-mermaid`, `/api/elements/sync`, `POST /api/files`, `DELETE /api/files/:id`,
  `POST /api/snapshots`, and the four browser round-trips.

The choice was the same one both times: guard them, or write down that a board bound to an
interface publishes its contents to whoever reaches the port and takes whatever they draw on it.
They are guarded. The consequence is stated rather than hidden: a non-loopback bind gives up the
board — #278 had already taken the tab strip and the picker with the registry, and this takes the
canvas itself, in both directions. A reverse proxy is unaffected, because it reaches this server
on loopback, which is the shape `EXCALIDRAW_ALLOWED_HOSTS` exists for.

What it does not give up is the handful of rows above marked **no bind guard**: the research and
implement records, which are in this process's memory rather than behind the funnel, and the two
routes that reset one. `scripts/check-guarded-routes-documented.mjs` is what keeps that list here
the same as the one in the code, and [SECURITY.md](SECURITY.md#where-it-listens) is where it says
what such a caller can read and change.

The guard tests the **bind address**, which is the one thing about a caller that cannot be
forged. The origin gate beside it tests `Origin` and `Host`, which is a question only a browser
has to answer honestly, and the token above tests what the caller carries. None of the three
stands in for the others — a request holding a valid token is still refused off loopback, and
the bind is the only one of the three still answering wherever `VIBEMAXXING_NO_AUTH` is set.
[SECURITY.md](SECURITY.md) is all of it in one place;
`scripts/check-board-reads-guard.mjs` holds the reads and
`scripts/check-board-writes-guard.mjs` the writes.

For a while the writes were not behind the bind guard, and this said so in a sentence rather
than deciding anything: a board bound off loopback could not be read by anybody and could still
be drawn on and emptied by anybody who reached the port. #456 put the same question to them and
gave it the same answer. The *board* is now refused in both directions off loopback — which is
not the same claim as the one this paragraph used to end on, that such a board is inert. The
rows marked no bind guard are why, and they are named one by one in
[SECURITY.md](SECURITY.md#where-it-listens).
