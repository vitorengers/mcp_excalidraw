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
  untouched. Minimal is `{ name }`, plus `docsDir` when the project actually has a `docs/`
  folder — stat-ed, not assumed, because `docsDir` is the only route documentation has and a
  config without it is a board where every `docKey` answers 404. A project whose documents live
  elsewhere gets the blank and fills it in the settings dialog; a project already registered is
  never rewritten to repair it.

## The order of the tabs

The strip renders the list exactly as `GET /api/workspaces` hands it over, and that route answers
`loadWorkspaces` verbatim, so **the order of the tabs is the array order of the registry** and has
never been anything else. It is not only cosmetic: `resolveInitialWorkspace` falls back to
`list[0].id` when neither `?workspace=` nor the remembered id names a known board, so the first
tab is the board a cold start opens.

`PUT /api/workspaces/order` with `{ ids: [...] }`, **loopback only**, writes it down. Drag a tab
along the strip, or put focus on one and press **Ctrl+Shift+←** / **Ctrl+Shift+→** — a drag-only
control on a `role=tablist` is unreachable without a pointer. `Ctrl+Shift` rather than `Alt`
because every board hotkey is `Alt` and nothing else (`isBoardHotkeyChord`), and plain arrows are
left alone because on a tablist they mean *move between tabs* rather than *move the tab*.

- **A permutation or nothing.** The list must name exactly the projects the registry loads back,
  each once. A list that adds, drops or repeats an id is refused with a 400 naming which, and the
  file on disk is left byte for byte as it was rather than partially applied — a caller sending a
  stale list has an idea of the board that is already wrong.
- **Entries move whole**, so a key somebody added by hand travels with the project it was written
  on, the same rule the `+` keeps. An entry the loader dropped — a duplicate path, one with no
  path — has no tab and so no position to state; it is kept, in its own relative order, after the
  ones that do.
- **Shared, not per browser.** The registry is the store because everything else about a project
  already persists in files the operator owns, and an order kept in `localStorage` would drift
  between two windows on the same board. The consequence is that dragging a project to the front
  also makes it the cold-start default for anyone with no remembered id — accepted rather than
  decoupled, because that is what position already meant.
- **Shown before it is written**, and reconciled against the list the route answers with, the way
  the `+` and the settings dialog already are. A refusal puts the strip back where it was.

`GET /api/fs/directories?path=` (loopback only) is the picker's other half. It has to run on the
server: the browser cannot learn a folder path at all — `showDirectoryPicker()` returns a handle
that deliberately exposes none, and `<input webkitdirectory>` gives only paths relative to
whatever was chosen — while the registry needs an absolute one. With no `path` it lists the
roots, which on Windows is the drive letters.

## board.config.json

```json
{
  "name": "Board Tool",
  "language": "English",
  "docsDir": "docs",
  "board": "docs/board.excalidraw",
  "repo": "vitorengers/mcp_excalidraw",
  "githubProject": "https://github.com/users/vitorengers/projects/5",
  "agents": {
    "issue":     { "model": "claude-fable-5", "effort": "high" },
    "implement": {
      "model": "claude-opus-5",
      "effort": "max",
      "timeoutSeconds": 5400,
      "workflow": "fable-plan-opus-build"
    }
  }
}
```

A config field pointing outside its own project is **ignored, not honoured** — the workspace is
still returned, with `error` explaining what was dropped. A project whose config is missing or
malformed is also still listed, carrying its error, because one broken project should not hide
the others and a workspace that silently disappears is harder to debug than one that shows up
broken.

`language` is the language the issues this board opens for the project are **written in**, and
unset is English — which is exactly what the prompt said outright before the field existed. It
is a name a model reads rather than a locale code, so `Brazilian Portuguese` says more than
`pt-BR` and costs nothing.

It exists because the prompt was right to *fix* the language and wrong to fix it to one. Issue
#20 came out entirely in Portuguese from an observation written in English: the investigation
sends the agent to read the project's own documentation first, that project documents in
Portuguese, and nothing in the prompt said otherwise. Saying English outright is what stopped
that, and none of this undoes it — the agent still may not take the language from the
observation it was handed or from the repository it just read. What changes is who decides.
This board opens issues in several repositories, and a project whose own conventions require
Portuguese was getting every card this tool opened for it written against its own rule; that is
a collision rather than a preference. See
[issue-block.md](issue-block.md#the-prompt) for the paragraph itself.

`agents` is per-project agent tuning: a `model` and an `effort` appended to the command the
operator configured, a `timeoutSeconds` that wins over the environment's ceiling, and a
`workflow` naming the text this project's agents are to follow. Every field is optional and
unset means *use the board default* — which is the only other value there is. A project
**cannot** configure the command itself; see
[issue-block.md](issue-block.md#what-is-per-project-and-what-stays-global) for why that boundary
is where it is.

## agent-workflows/

`agents.<kind>.workflow` is a **slug**, matching `[a-z0-9][a-z0-9-]*`, naming
`<project>/agent-workflows/<slug>.md`. The text in that file is read when a run starts and
appended to the agent's prompt as its last section — so a project that runs a pipeline (plan on
one model, review the plan, implement, review the implementation) can say so, where before the
prompt only pointed vaguely at "your own project memory".

```
my-project/
  board.config.json          "agents": { "implement": { "workflow": "fable-plan-opus-build" } }
  agent-workflows/
    fable-plan-opus-build.md  the text the implement agent is told to follow
```

The directory sits at the project root and the file has to be **committed**: an implementation
runs in a worktree cut from the default branch, so anything gitignored — `.claude/`, `.agent/`,
`.agents/` — resolves on the maintainer's checkout and is missing in every board run.

Two things are unlike the rest of this file, and both on purpose:

- **An unresolvable workflow refuses the run**, before the agent is spawned, with the path it
  looked for in the error the block shows. A config field pointing outside its project is
  ignored, because the cost is a panel that shows nothing and says why; the cost of a workflow
  quietly not applied is a run that looks completely normal and did the wrong thing.
- **It is text for the prompt, and nothing else.** It reaches no command line, no environment
  variable, no `--allowedTools`, and it grants the project nothing it did not already have —
  the agent was already reading this repository and its memory. `agents.<kind>.workflow` says
  how to use what the operator granted; only the operator grants.

`scripts/check-agent-workflow.mjs` is the check: the same argv with and without a workflow, the
prompt unchanged byte for byte when none is selected, and every escaping name refused.

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
  `scripts/check-workspace-reorder.mjs`, `scripts/check-workspace-tabs-browser.mjs`
