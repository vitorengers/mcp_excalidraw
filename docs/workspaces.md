# Workspace registry

One project per board. A registry file lists the projects; each project then describes its own
board settings in a `board.config.json` at its root, the way it already carries a package
manifest. Settings travel with the project instead of piling up in one machine's global config.

## The registry

`EXCALIDRAW_WORKSPACES` points at a JSON file. **It is optional**: with the variable unset the
registry is `workspaces.json` in the same per-user directory as `config.json`, the pidfile and
the restart log — `%LOCALAPPDATA%\Excalidraw-Canvas\` on Windows,
`~/Library/Application Support/excalidraw-canvas/` on macOS,
`$XDG_STATE_HOME/excalidraw-canvas/` (or `~/.local/state/…`) on Linux. Nothing is written until
the first project is added, so a board that has never had one has no file.

Either way the shape is the same:

```json
{
  "workspaces": [
    { "id": "fica-ai",    "path": "C:/Users/you/Documents/Projects/FicaAI" },
    { "id": "board-tool", "path": "C:/Users/you/Documents/Projects/mcp_excalidraw" }
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
- **There is nowhere it cannot write.** A registry that does not exist yet — named or default —
  is simply the empty registry, and the first `POST` creates it, making its directory if it has
  to. This used to be a 503 refusal naming `EXCALIDRAW_WORKSPACES`, on the one board where the
  strip that holds the `+` had removed itself, so nothing on screen could have shown it.
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
roots, and what a root is depends on the machine: on Windows the accessible drive letters,
because there is no single filesystem root to open on and a picker starting at `C:/` could
never reach `D:/`; everywhere else the **home directory first**, then `/`, plus `/Volumes` on
macOS when it exists. `/` is a root on those platforms and a poor place to be put — this is the
first screen of the product, and opening on it meant clicking past `System`, `private` and
`cores` on a mac, or `proc`, `sys` and `dev` on Linux, to reach anything a person owns. It is
still in the same listing, so nothing above home became unreachable.

The dialog's typed-path field takes its example path from the same question, asked once through
`GET /health`, which reports the server's `platform`. It was `C:/Users/me/Projects/thing`
everywhere before that — the only concrete path this tool ever shows, in the wrong syntax for
two of the three platforms it runs on.

## board.config.json

```json
{
  "name": "VibeMaxxing",
  "language": "English",
  "docsDir": "docs",
  "board": "docs/board.excalidraw",
  "repo": "someone/their-tool",
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

`repo` is **written at registration**, from the project's own `origin`: `POST /api/workspaces`
reads `git remote get-url origin` in the folder that was chosen and writes `owner/name` into
the config it creates. A folder that is no repository, or whose remote is not GitHub, gets no
`repo` key at all rather than a guess — the panel reconstructs issue URLs from it, and an
invented one points at somebody else's issue. It stays editable in the settings dialog, and a
project that already has a config keeps whatever that config says: this runs when the file is
created and never again.

There is no equivalent for `githubProject` and there will not be. A project board belongs to an
account, nothing on disk implies which one, and `readProjectBoard` runs `gh` against whatever it
is given.

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

## board.config.local.json

The same settings, for one machine rather than for the repository. It sits beside
`board.config.json`, it is gitignored, and it **wins** where the two disagree — shallow, except
`agents`, which merges one level down so a locally pinned implement model does not erase the
issue agent the project configured for everybody.

It exists because two of these settings are not properties of the tool at all. `repo` and
`githubProject` name an *account*, and this repository used to ship both in its tracked config:
a stranger who cloned the release and registered the clone as a board — the path the README's
own fork section leads to, since the tool ships a `docs/` tree and a `docs/board.excalidraw` —
got a board mirroring the maintainer's GitHub project, running `gh` against it, and marking
every card on it undraggable. So this repository's `board.config.json` names a board and a docs
directory and nothing about GitHub, and the machine it is developed on carries the rest:

```json
{
  "repo": "someone/their-tool",
  "githubProject": "https://github.com/users/someone/projects/5"
}
```

The second reason is the settings dialog. It writes this file, and a dialog writing into a
git-tracked config means every settings edit dirties the working tree of whatever project is
open — including this one's.

**A setting is written back to the file it was read from.** The dialog is shown the two files
merged, because what it has to show is what is in force; on save, a setting the overlay already
carries goes to the overlay and everything else goes to `board.config.json`. Both alternatives
fail visibly: writing everything to the shared file leaves the edit shadowed and saving appears
to do nothing, and writing everything to the overlay copies the whole config into a file nobody
shares, so the project's own settings stop reaching this machine. Clearing an overridden setting
removes it from the overlay, which brings the shared value back.

An overlay that is there and unreadable is an **error on that workspace**, the same as a
malformed `board.config.json`. Absent is the ordinary case and says nothing.

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

### Five rows, and `Advanced`

The dialog opens on **Name, Issue language, Docs folder, GitHub repo and GitHub project**, each
marked *optional*. Everything else — Board file, Library file, Project field, Cards per column,
the two column names, and both agent fieldsets — is behind an `Advanced` control.

It used to open on all of them: eleven free-text rows and two fieldsets of four, presented the
moment a folder is picked, with nothing saying any of it could be left alone. That is a
questionnaire rather than a form, and every answer on it already had a default that is right
until somebody has a reason.

The hidden rows are **unmounted, not hidden**. `<details>` and `display: none` both leave every
one of them in the tab order and in a screen reader's reading of the form, which is the thing
that made the dialog read long in the first place. Nothing else changes with the disclosure: the
draft holds the whole config either way and the save sends all of it, so **a collapsed dialog
saves the settings it never showed** rather than clearing them.

`Workflow` is a row in each agent fieldset, and it is new. `agents.<kind>.workflow` — the one
setting that changes *what a run does* rather than how well it runs — was accepted by the write
path and refused by the dialog, which sent `model`, `effort` and `timeoutSeconds` and nothing
else. Blank still means the board default, and a project that already selects a workflow sends
its own value back, so leaving the field alone cannot clear it.

`scripts/check-workspace-settings-browser.mjs` is the check, and it is a browser one because
"in the DOM only after `Advanced` is pressed" is a claim about the DOM.

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
  `scripts/check-workspace-reorder.mjs`, `scripts/check-workspace-tabs-browser.mjs`,
  `scripts/check-workspace-settings-browser.mjs`
