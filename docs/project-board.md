# Project board mirror

A region on the left of the canvas showing the workspace's GitHub project: one section per
column, newest issue on top, cards you can drag between columns with the move travelling back to
GitHub. Dormant unless a project names a `githubProject`, so a board that has none never grows
one.

Nothing here names a column. That is the whole point — a fourth option added on GitHub is a
fourth section on the next poll, with nothing edited in this repository.

## Where the columns come from

A user-owned project has **no board view**: `views(first:5)` returns a single `TABLE_LAYOUT` node
with `verticalGroupByFields` empty, so there is no grouping to read. The columns are therefore
taken from the options of a single-select field, `Status` by default because that is the field
GitHub creates. A project that groups by something else says so:

```json
{ "githubProject": "https://github.com/users/you/projects/5", "projectField": "Stage" }
```

`projectCardLimit` caps how many cards a section shows; it defaults to 12 and applies to every
section rather than to Done alone. Done is the section the cap exists for — eleven of fourteen
items were already Done when this was written, and that only grows — but a cap that knew the name
"Done" would be exactly the constant this feature is built to avoid. What is left out is counted
in the section header and logged, never silently dropped.

An item the project holds but never gave a status lands in a **No Status** section rather than
disappearing. That section only appears when something is in it.

## Both directions go through `gh`

`src/core/gh.ts`, reusing `agentPath()` and `buildAgentCommand()` from the issue agent. No new
HTTP client and no token to store: `gh` is already required here, already carries the `project`
scope from your own login, and the two traps around it — a PATH without the CLI on it, and a WSL
project whose paths only make sense inside the distro — are already paid for.

Reading is one `gh api graphql` call returning the project id, the field, its options and the
items, because a move needs the first three and the mirror needs the last. The query is built on
one line: it travels as a single command-line argument through a tokenizer and, for a WSL
workspace, through `bash -lc`, and a string that can hold neither a quote nor a line break cannot
be broken by either. Anything interpolated into it — the owner login, the field name, every node
id — is matched against a pattern first and refused outright otherwise.

Writing is `gh project item-edit --id … --project-id … --field-id … --single-select-option-id …`.
It is retried like every other `gh` call here, which is safe because setting a single-select field
is idempotent. The first real move made from this machine failed on `dial tcp` — the same socket
buffer exhaustion the issue reader already retries — and without a retry that blip reaches the
canvas as a card snapping back for no reason anyone can see.

`EXCALIDRAW_GH_COMMAND` overrides the binary, which is how `scripts/check-project-board.mjs`
answers without a GitHub account behind it.

## Polled, because there is nothing to subscribe to

`projects_v2_item` webhooks are organisation-scoped, and a user account has no hooks endpoint at
all — `GET /users/<login>/hooks` is 404 and the repository's hooks are `[]`. So the canvas polls,
every twenty seconds, and only while the tab is on screen. A run that just finished refreshes
immediately rather than waiting out the interval: that is the one moment the project changed for a
reason the canvas already knows about.

## Two guards

Both routes are **loopback only**. The move route because it writes — a canvas reachable from the
network must not be able to rearrange somebody's project board — and the read route for the same
reason `GET /api/issue-block/:id/issue` is: reading is not writing, but it still spawns a process
holding your `gh` credentials.

A move is not taken on trust either. The server re-reads the board before writing, so the option
has to be one this project actually has and the item has to be on it; the project and field ids
are never the caller's to supply. It costs one extra `gh` call per drag, and it means a stale
canvas cannot write a column that no longer exists.

## Derived, never authored

Every shape the mirror draws carries `customData.kind = "project-board"`. That mark is load
bearing in three places:

- the browser strips them before `POST /api/elements/sync`, so they are never stored;
- `scripts/export-board.mjs` strips them again, so they never reach `docs/board.excalidraw`;
- the canvas replaces them wholesale on each refresh rather than merging.

Two doors for one rule, because the element store is shared and only one of them needs to be
missed. A saved copy of the mirror would be a snapshot of somebody's Todo column from whenever the
export happened to run — stale on arrival, and churning the diff every time anyone moved a card.

Section headers are locked so they cannot be dragged out of a region that would only put them
back. Cards are not: dragging one *is* the interface. A card that cannot be moved — a pull request,
or an issue from another repository — is locked instead, so the canvas refuses the drag rather than
accepting one the server would have to undo.

## Dragging a card

The move is written on the **end** of a drag, not during it: a card crosses columns on its way
anywhere, and writing every crossing back would rewrite the project several times per gesture.
Whichever column the card's centre lands in is the answer. Anything that landed in a gap, or on a
column it cannot be moved to, snaps back to where GitHub still says it belongs.

A failed move snaps back too, and writes the reason onto the card. The snap-back on its own is
ambiguous — it reads like a drag that did not take — so the message is what makes it an error.

## The `+`

The first column carries a `+` that drops an issue block at the top of it. Which column that is
comes from the project rather than from a name written here: GitHub's *Item added to project*
workflow is what gives a new issue a status, and it puts it in the first option, so that is the
only column this can honestly create into.

The block comes from the library (`docs/blocks.excalidrawlib`, through `GET /api/library`) rather
than being built here, because what makes a block functional is `customData.kind` and a second
definition of that shape would drift from the one the library ships. It is marked
`projectBoardDraft` and is a **real, authored** element: it persists, it syncs, and it is yours
until the issue exists. The mirror leaves room for it at the top of its column.

When the run finishes and the refreshed board holds a card with the same `issueUrl`, the draft is
deleted — matched on the URL because that is the only thing the block and the card provably share.
A run that failed leaves its block alone: there is nothing to replace it with, and the observation
is still worth keeping.

## The hotkey

**Alt+B** scrolls the viewport onto the mirror. `Alt` because Excalidraw owns the bare letters —
every tool has one — and much of `Ctrl+Shift`. It is matched on `event.code`, so it survives a
keyboard layout where Alt produces a different character, and it is bound on `window` rather than
on the canvas, because the canvas never sees a key pressed outside it.

It stands down while text is being edited. Excalidraw edits labels in a real `<textarea>`, so what
has focus is the honest test — and it is what keeps this from swallowing a keystroke meant for a
card's title.

## What it does not do yet

- **Only the first page of items**, 100 of them, is mirrored. Beyond that the server logs a
  warning rather than paginating.
- **A card shows its number and title, nothing else.** Labels, assignee and state colour each cost
  a wider query.
- **Cards from other repositories, and pull requests, are read-only.** They render; they do not
  move.
- **Order will not match GitHub's.** Items come back in `POSITION` order — whatever arrangement
  someone dragged them into — and newest-first is sorted here.
