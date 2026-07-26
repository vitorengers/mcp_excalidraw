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

## It is memory only

Nothing writes the store to disk. `boardFile` is resolved from `board.config.json` and exposed
by `GET /api/workspaces`, but no code loads or saves it: persistence is a manual export, and a
board that is not exported dies with the process.
