# Workspace registry

One project per board. A registry file lists the projects; each project then describes its own
board settings in a `board.config.json` at its root, the way it already carries a package
manifest. Settings travel with the project instead of piling up in one machine's global config.

## The registry

`EXCALIDRAW_WORKSPACES` points at a JSON file:

```json
{
  "workspaces": [
    { "id": "fica-ai",    "path": "C:/Users/vtr_d/Documents/Projects/FicaAI" },
    { "id": "board-tool", "path": "C:/Users/vtr_d/Documents/Projects/mcp_excalidraw" }
  ]
}
```

`id` is optional — without it the id is derived from the last path segment. A `distro` field
marks a WSL-backed project, and Windows and WSL spellings of the same path collapse onto one
canonical key so a project cannot register twice.

The file can still be written by hand, and often is. It is no longer the only way in: the `+`
at the end of the tab strip appends an entry to it.

## Adding a project from the board

`POST /api/workspaces` with `{ path, id?, distro? }`, **loopback only** like every other route
that writes to this machine. It stats the directory, canonicalises the path, refuses a duplicate —
the two spellings of one WSL project are one project — appends a single entry, and answers with
the reloaded list. The registry is read per request, so the new project is live immediately and
nothing restarts.

Three things it is careful about, because the registry belongs to whoever runs the board rather
than to this repository:

- **Keys it does not understand survive.** The file is read, modified and written back, never
  re-serialised from the shape this code knows, so a comment field or a setting added by hand is
  still there afterwards.
- **No registry configured is a refusal with a reason**, naming `EXCALIDRAW_WORKSPACES`. A `+`
  that silently did nothing would be the worse failure. A registry that is configured but does
  not exist yet is simply the empty registry, and gets created.
- **A project with no `board.config.json` is given a minimal one**, so its tab does not arrive
  already marked broken by `No board.config.json at …`. A project that has one keeps it,
  untouched.

`GET /api/fs/directories?path=` (loopback only) is the picker's other half. It has to run on the
server: the browser cannot learn a folder path at all — `showDirectoryPicker()` returns a handle
that deliberately exposes none, and `<input webkitdirectory>` gives only paths relative to
whatever was chosen — while the registry needs an absolute one. With no `path` it lists the
roots, which on Windows is the drive letters.

## board.config.json

```json
{
  "name": "Board Tool",
  "docsDir": "docs",
  "board": "docs/board.excalidraw",
  "repo": "vitorengers/mcp_excalidraw",
  "githubProject": "https://github.com/users/vitorengers/projects/5",
  "agents": {
    "issue":     { "model": "claude-fable-5", "effort": "high" },
    "implement": { "model": "claude-opus-5",  "effort": "max", "timeoutSeconds": 5400 }
  }
}
```

A config field pointing outside its own project is **ignored, not honoured** — the workspace is
still returned, with `error` explaining what was dropped. A project whose config is missing or
malformed is also still listed, carrying its error, because one broken project should not hide
the others and a workspace that silently disappears is harder to debug than one that shows up
broken.

`agents` is per-project agent tuning: a `model` and an `effort` appended to the command the
operator configured, and a `timeoutSeconds` that wins over the environment's ceiling. Every
field is optional and unset means *use the board default* — which is the only other value there
is. A project **cannot** configure the command itself; see
[issue-block.md](issue-block.md#what-is-per-project-and-what-stays-global) for why that boundary
is where it is.

## Editing it from the board

The gear on the tab in front opens the project's settings. It reads
`GET /api/workspaces/:id/config` — the file as it is on disk, not the loaded workspace, so a
blank field can go on meaning "not set" — and saves through
`PUT /api/workspaces/:id/config` (loopback only), which:

- **round-trips the file**, so keys nobody here knows about are kept. `loadWorkspace` returns a
  fresh object literal and never spreads the parsed config, so re-serialising the loaded shape
  would quietly delete the rest of the file;
- **clears rather than nulls**: a field left blank is removed, so the config stays the small
  readable file somebody would have hand-written;
- **refuses a value of the wrong type**, by name. That is not fastidiousness. `loadWorkspace`
  calls `config.name?.trim()` *outside* its own try/catch, so a `name` that is a number throws,
  rejects the `Promise.all` in `loadWorkspaces`, and `GET /api/workspaces` answers 500 — every
  tab disappears. That is latent while configs are hand-written by one person and stops being
  latent the moment a UI writes them, so nothing of the wrong type is written in the first
  place. Hardening the *read* path against a config edited by hand is a separate matter.

A field it has never heard of is refused rather than stored, so a typo says so instead of quietly
doing nothing.

## What reads it

`GET /api/workspaces` loads the registry **per request**, not once at boot: a project's config
gets edited while the server runs, and restarting to notice would be silly. The docs endpoint,
the library endpoint and the issue block each resolve their own workspace the same way. Both
agents resolve their model, effort and ceiling per run for the same reason.

- `src/core/workspaces.ts` — registry and config loading, and both write paths
- `src/core/workspace-paths.ts` — Windows/WSL path canonicalisation
- `src/core/directory-browse.ts` — the picker's directory listing
- `frontend/src/components/WorkspaceTabs.tsx`, `WorkspaceDialogs.tsx` — the strip, the `+`, the
  two dialogs
- `scripts/check-workspaces.mjs`, `scripts/check-workspace-isolation.mjs`,
  `scripts/check-workspace-create.mjs`, `scripts/check-workspace-settings.mjs`,
  `scripts/check-workspace-tabs-browser.mjs`
