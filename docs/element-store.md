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

**`default` is a store like any other.** It used to be the `Map` exported from `types.ts`, kept
that way so anything importing it directly stayed on the same data. By #314 nothing did, and
being a plain `Map` had a cost that landed on exactly one board: it could not report its own
changes, so the board a user with no project registered draws on was the one board that
structurally could never be saved. The export is gone and `default` is created on first use,
watched, and seeded and saved like every registered project.

## It is read at startup, and written as it changes

The store no longer starts empty. After `listen`, `seedBoardsFromFiles` reads each registered
project's `boardFile` — the `board` field of its `board.config.json`, resolved in
`src/core/workspaces.ts` — and puts the scene into that workspace's store. A project that declares
no `board` is left empty: seeding from a *tracked file* is opt-in, so a board that is meant to start
blank can. `default` is seeded too, even though it is nobody's project and has no tracked file —
it has only the state this canvas keeps of it, and it is the board somebody who has registered
nothing is drawing on. It is skipped only when a registered project carries that id, which would
otherwise seed one store twice.

Boards are read concurrently and none of it is awaited, for the reason recovery is not: one of these
projects lives on the `wsl$` share, where the read crosses a distro boundary and is refused outright
when the distro is down, and that is no reason for the local boards to wait or for the port to open
late. A board that cannot be read is warned about and skipped.

The seed is broadcast as `elements_batch_created`. A direct store write tells nobody, and a browser
that connected while the read was in flight took its `initial_elements` from an empty store.

## The save half

Every board a registry lists — and `default`, which no registry lists — is written back, a second
after it last changed, by `src/core/board-state.ts`. That is what makes a My Notes draft survive a restart: a draft has no
issue, no branch and no project item behind it, so the canvas was the only place it existed and a
process that stopped took it with it (#225).

**Not into the board file, and not into any project.** `docs/whats-next.md` was right about that: a
board file is a tracked artifact and a commit like any other, and a process writing to one on a timer
would put diff noise into somebody's working tree. Boards are saved beside the *registry* instead, in
a directory named after it — `board-workspaces.json` keeps them in a `board-workspaces-state` directory —
through a temporary file and a rename, the way `workspaces.ts` writes the registry itself.
`EXCALIDRAW_BOARD_STATE` names a different directory. The registry it follows is the one
`registryPath()` resolves, default included, so a project registered on a first-run board saves
beside `workspaces.json` in the per-user state directory rather than nowhere.

Beside the registry rather than in one shared directory for a reason that is not tidiness: a
workspace id is unique *within a registry* and nowhere else, and every self-contained check in
`scripts/` starts a server against a throwaway registry of its own. One shared directory would let a
check's `board-tool` write over the real `board-tool`'s saved drafts.

**Every store reports its own changes.** `elementsFor` hands out a `Map` subclass that calls the
listener `onElementStoreChanged` registered, so the dozen writers — the element routes, the batch,
the sync reconciliation, the issue and implement writers, the seed — do not each have to remember to
save. A writer that was missed would be a change that is silently never written, which is the
failure this closes. Every store is watched, `default` included since #314 — there is no longer
a store that reports nothing, and so no warning left to read.

The write is debounced by a second, with a five-second ceiling so that continuous editing cannot
push it back indefinitely, and what a shutdown still owes is written synchronously on the way out.
A process that is killed outright loses at most that second — which is why the debounce is a second
and not a minute.

**What is saved.** Everything the store holds except what is nobody's to save: the GitHub project
mirror is rebuilt from GitHub on every read, and the terminal's block exists for as long as its
shell does. The browser already keeps both out of the autosync and `scripts/export-board.mjs` keeps
them out of the export; this is the third door, and it needs to be, because the store is reachable
from the REST API too. Files are not saved, exactly as the export does not save them: an image
pasted onto a board comes back as an element whose file the process no longer holds.

`scripts/export-board.mjs` is still the only path into the tracked board file, and still run by hand.

## What is kept when a board is emptied

`DELETE /api/elements/clear` writes the store out first, to
`<workspace>.cleared-<when>.excalidraw` in the same directory as the saved board, and answers with
that path in `backup`. Nothing reads it back automatically — `readBoardState` opens
`<workspace>.excalidraw` by name, so a copy beside it is never mistaken for the board — and
nothing deletes it either. It is a file for a person, or for the agent that has just been told
where it is.

The copy is taken **in the route** rather than in the callers. Everything that empties a board
comes through there, and only one of those callers has a person in front of it: the header's
`Clear Canvas` confirms first, but the MCP `clear_canvas` tool, the CLI's `clear --yes` and
`restore_snapshot` — which clears *before* it restores — do not, and must not start to. A
confirmation in front of the route would break an agent-facing contract; a copy behind it breaks
nothing.

It is not gated on whether the board is one of the saved ones. That gate is there so a request
naming a workspace nobody registered cannot create a file per typo, and it cannot here either: a
store nobody has written to has no elements, and a board with no elements is not copied. What
the gate would cost instead is the case the copy exists for — an unregistered board holding the
only copy of something, emptied by a tool call (#345).

## Which of the two a board comes back from

The saved state, normally: it is written a second after every change, so it is the newer of the two
by definition.

Unless the board file has been written *since* — a pull, a merge, a fresh export — in which case the
file is the base, because somebody deliberately changed it, and the elements only this process ever
knew about are put back on top of it. That is what keeps a board updated elsewhere from arriving
stale, and a draft with no copy anywhere else from being the price of updating it. Both branches say
in the log which one happened and which file was read, because a committed board silently overridden
by process leftovers is exactly the thing worth being able to read about afterwards.

### What a seed may assert

`src/core/board-seed.ts` turns a `.excalidraw` file into elements to seed, and the one judgement it
makes is about `customData`. It is the door both sources come in by — a saved board is read through
`parseBoardScene` exactly as a tracked one is, because a board saved a second before the process was
killed is precisely as unable to tell a live run from an abandoned one. Seeded elements *are* the
store, and the store outranks the browser for
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
