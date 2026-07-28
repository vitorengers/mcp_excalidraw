# Element store

Elements used to live in a single module-level `Map`. That is fine while a server serves one
board. With several projects open as tabs it lets one board's autosync reach into another's
elements — the same class of silent data loss as the clear-and-replace sync this project
already fixed.

Now there is one `Map` per workspace, in `src/core/element-store.ts`.

## How a request finds its store

`workspaceIdFrom()` reads, in order: `?workspace=`, a `workspace` field in the body, then the
`x-workspace-id` header. Anything missing or malformed resolves to the `default` store rather
than failing — a request that cannot name its workspace is far more likely to be an older
client than an attack.

Ids are normalised to `^[a-z0-9][a-z0-9._-]{0,63}$` before they are compared or logged.

## Two deliberate choices

**Stores are created on first use.** There is no registration step: an unknown workspace id
yields an empty store instead of an error. A board can exist before its project is listed in
the registry, and a typo costs an empty canvas instead of corrupting a real one.

**The default store is the `Map` exported from `types.ts`.** Anything still importing it
directly — the CLI, for one — keeps operating on the same data.

## It is read at startup, and never written

The store is still memory only, but it no longer starts empty. After `listen`, `seedBoardsFromFiles`
reads each registered project's `boardFile` — the `board` field of its `board.config.json`, resolved
in `src/core/workspaces.ts` — and puts the scene into that workspace's store. A project that declares
no `board` is left empty: the feature is opt-in, so a board that is meant to start blank can.

Boards are read concurrently and none of it is awaited, for the reason recovery is not: one of these
projects lives on the `wsl$` share, where the read crosses a distro boundary and is refused outright
when the distro is down, and that is no reason for the local boards to wait or for the port to open
late. A board that cannot be read is warned about and skipped.

The seed is broadcast as `elements_batch_created`. A direct store write tells nobody, and a browser
that connected while the read was in flight took its `initial_elements` from an empty store.

**Writing is still manual.** `scripts/export-board.mjs` is how a board reaches its file, and a change
that is not exported still dies with the process. The load half is #184; the save half is not written.

### What a seed may assert

`src/core/board-seed.ts` turns a `.excalidraw` file into elements to seed, and the one judgement it
makes is about `customData`. Seeded elements *are* the store, and the store outranks the browser for
the fields in `SERVER_AUTHORED_CUSTOM_DATA` — that is [#118 working as designed](sync-reconciliation.md).
So a scene carrying a run that was in flight when the last process stopped would come back asserted
as true, for an agent that died with that process, with no way for a browser to correct it.

A seed therefore asserts what is finished and never what is running. An issue that exists still says
so, and so does an implementation that ended in a pull request. An `issueState` of `running` is
demoted exactly as `DELETE /api/issue-block/:id` demotes a stuck one — to `created` when the block
already has its `issueUrl`, otherwise to a draft — and the block is repainted to match. An
`implementState` that is not `done` or `failed` is dropped with the four fields beside it;
`interrupted` goes with `running` because `recoverInterruptedRuns` derives that state back out of git,
which is the only participant that was still there.

A tombstone (`isDeleted`) is dropped rather than stored: it travels through a live sync so a client
can be told about a removal it has not seen, and a board read from cold has nobody to tell.

`scene.files` is read into the process-wide file store. Nothing comes back through it today —
`scripts/export-board.mjs` writes an empty `files` object unconditionally — and it is what keeps the
first export that does save them from seeding image elements as broken references.
