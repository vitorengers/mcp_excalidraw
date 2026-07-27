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

## What a card's colours mean

A card carried its column's identity all along — every one is written with `sectionOptionId` —
and drew none of it, so a card in the first column looked exactly like a card in the last. It is
now filled from a list of tints running alongside the column strokes, indexed the same way and
wrapping the same way.

**The fill comes from where a section sits, never from what it is called.** A project that
renames a column, or adds a fourth, still gets no edit in this repository — the same rule the
rest of this file keeps. `check-block-appearance.mjs` pins it down on a fixture whose sections
are named `Icebox` / `Underway` / `Shipped`, so a hardcoded `Todo` could not pass, and it renames
them to prove nothing keys on a string.

A card that cannot be moved keeps its grey fill instead. "Not this board's to rearrange" outranks
which column it happens to be sitting in.

The outline is a second, independent fact: **whether an agent is on it.**

| Outline | Means |
| --- | --- |
| thin, solid | nothing is being implemented |
| thick, dashed | a run is in flight |
| thick, solid | a run produced a pull request |

Weight and outline rather than another colour, because hue is already spoken for by the column
and by a failed move, and a third meaning for it would collide with both. Dashed while the work
is in flight and solid once it has landed is the same reading an issue block's own outline has.

**In Progress and "an agent is implementing" are different facts, and this is the distinction
that keeps them apart.** A card is in a column because somebody dragged it there or changed it on
GitHub; whether a run exists is the implement record, keyed by issue URL, which is the only place
that can honestly answer it. A card dragged to In Progress with no agent behind it draws no
outline, which is the normal case rather than an edge one.

A `failed` record draws nothing. The run is over and nothing is being implemented, which is what
an unmarked card already says; the failure itself is reported in the panel.

The records reach the canvas from `GET /api/implement` with no `url`, read on the same
twenty-second poll as the board. It costs no `gh` — the route reads the in-memory map and
nothing else — and it cannot come from the cards, which are redrawn from GitHub every time.

## Dragging a card

The move is written on the **end** of a drag, not during it: a card crosses columns on its way
anywhere, and writing every crossing back would rewrite the project several times per gesture.
Whichever column the card's centre lands in is the answer. Anything that landed in a gap, or on a
column it cannot be moved to, snaps back to where GitHub still says it belongs.

A failed move snaps back too, and writes the reason onto the card. The snap-back on its own is
ambiguous — it reads like a drag that did not take — so the message is what makes it an error.

## The `+`

The notes column carries a `+` that drops an issue block at the top of it. That column is
**the canvas's own**: it is drawn from a reserved id in `project-board-types.ts`, not from a
`Status` option, and it is put in front of the project's columns by `layoutMirror` before
`layoutBoard` sees them. Nothing mirrored can ever be in it, so its header counts drafts and
nothing else, and a card dragged onto it snaps back in silence — there is no option to write, and
the reserved id is refused by the `NODE_ID` pattern every write to the project goes through.

It was an option on GitHub until #97, and drawn on `index === 0`: whichever option the project
declared first. The argument for that had already been retired — it was originally "the `+` is on
the first column because *Item added to project* puts a new issue in the first option, so that is
the only column this can honestly create into", and the `Todo` move made the landing column this
server's decision instead. What was left was an empty option existing solely to lend its id to
blocks that live on the canvas: project 5 declared `My Notes` and held 48 items, none of them in
it. Delete the option and the `+` moves onto `Todo`, where observations and real issues share a
column again, while every block still carrying the old id names a column the board no longer has —
placed nowhere, counted by nothing, overlapped by the next redraw.

Blocks naming a column that is gone are **rehomed into the notes column** (`layoutMirror`), which
is the one rule #97 reverses rather than adds. `layoutBoard` still leaves such a block where it
sits: none of the project's columns is where it *belongs*, only where it might be guessed to. The
notes column is where it belongs by construction — every draft was written as an observation.

The name `My Notes` is the one column name in this repository that is a constant, and it has to
be: every other name is GitHub's because every other column is GitHub's.

The block comes from the library (`docs/blocks.excalidrawlib`, through `GET /api/library`) rather
than being built here, because what makes a block functional is `customData.kind` and a second
definition of that shape would drift from the one the library ships. It is marked
`projectBoardDraft` and is a **real, authored** element: it persists, it syncs, and it is yours
until the issue exists. The mirror leaves room for it at the top of its column.

Blocks stack **newest on top**, the same rule the cards follow, ordered by the
`draftCreatedAt` the `+` stamps onto each one — a timestamp seeded into an id would have been a
weaker key, and an id is the one field anything on the canvas is free to rewrite. A block made
before that field existed carries none; for those the stamp in the id is read instead, and a block
with neither keeps the order the scene holds it in, below the dated ones, so an old scene still
lays out the same way twice running.

**Nothing drops that field.** This page used to say something between `instantiateIssueBlock` and
the scene did, and that the id was the only key that survived. It was wrong, and the code was
patched around it. `draftCreatedAt` survives `convertToExcalidrawElements`, the round trip through
`POST /api/elements`, and a reload: with the fallback taken out altogether the drafts still stack
newest-first, which is the only way to show that the field rather than the id is doing the work,
because the `+` builds both from one `Date.now()` and they otherwise agree by construction.
`scripts/check-board-drafts-browser.mjs` now reads the field back out of the scene after a click,
and then sets one block's field against what its own id says to prove which of the two is read.

What that belief was actually looking at is worth keeping, because it is a trap this project has
in writing (`docs/trap-stale-server.md`): a scene whose blocks carry exactly `kind`,
`projectBoardDraft` and `sectionOptionId` and no timestamp is what the `+` wrote *before* the field
was added. The browser check drives a Chrome against `dist/frontend`, never against the source, so
a `vite build` that was not re-run — or an old server still serving the one it has — is enough to
read the previous version's behaviour off a screen and take it for the current one's. The reading
was of an artifact, not of a bug.

That run was also the first in which the `+` could be clicked at all: the check's server ran
without `EXCALIDRAW_LIBRARY`, the library came back empty, and `addIssueBlockToColumn` warns to the
console and returns when no template carries `customData.kind === "issue"`. Every click was a
silent no-op, so the ordering assertions had never reached the thing they were about.

A block grows as its title is typed, because an Excalidraw container grows to fit the text bound
to it, and everything below it in the column moves down as it does — on the keystroke, not on the
next poll. The block under the caret is the one thing a relayout leaves alone: rewriting a
container and its label out from under a text editor is how the editor gets closed, or corrupted.
It is put back in its slot as soon as the editor closes. All of this is arithmetic, so it lives in
`layoutBoard` rather than in the component: pass the drafts in and it returns where each one goes
and how much room the cards give up (`scripts/check-board-drafts.mjs`). What a browser still has to
confirm is that the arithmetic is wired to a keystroke at all, which
`scripts/check-board-drafts-browser.mjs` drives a real Chrome to do.

When the run finishes and the refreshed board holds a card with the same `issueUrl`, the draft is
deleted — matched on the URL because that is the only thing the block and the card provably share,
and **never on the column**, which by then is one the card could not be in at all: the block is in
the notes column and its card is on the project, moved to `Todo`. A run that failed leaves its
block alone: there is nothing to replace it with, and the observation is still worth keeping.

## What a section header counts

One number, and it counts **everything the column holds**: the blocks the `+` dropped, the
mirrored cards, and the cards the cap left out.

```
My Notes (2)            two blocks dropped by the +, and nothing else it could hold
Todo (1)                one issue, and nothing hand-written under it
Done (12, 9 hidden)     twelve issues, nine of them left out by projectCardLimit
Todo (14, 9 hidden)     one draft, four cards drawn, nine the cap left out
```

The notes column is the one case where the number is always the draft count: no project item can
be in it, so there is nothing else to add. It is still the same rule rather than a special one —
`headerText` sums drafts, cards and hidden for every column, and two of those are zero here.

It carried two numbers for a while, `drafts / cards`, because two populations shared one column
and the header had to say which was which. They no longer share one: observations are written in a
column of their own and a researched issue is moved to `Todo`, so the split is done by the columns
and repeating it in the header says nothing.

**This is not a revert.** The single number this header had *before* that was `cards + hidden` —
the mirrored items alone — which is why a column holding three drafts and no cards read
`Todo (0)`, the defect #79 recorded. Restoring it would move that defect one column left, onto
the column the drafts now have to themselves. The drafts stay in the sum; only the slash goes.

The cap decides what is *drawn*, never what is *held*, so the hidden cards are in the total and
`, N hidden` still qualifies the card side — the only side a cap applies to.

The draft count comes from the same `options.drafts` that decides where the blocks go, so the
header and the column cannot disagree, and it moves on the click that drops a block rather than on
the next poll. Nothing new is read from GitHub and nothing new is stored. **Which drafts belong to
a column is decided by `sectionOptionId`, never by a name** — and a draft naming a column that is
not drawn is counted by the notes column, for the same reason it is placed there.

Splitting the mirrored cards by who created the issue is a different feature and is not this one:
the provenance does not exist anywhere durable. The agent runs `gh` under the maintainer's own
login, there is no label convention, and the local trace is deleted on purpose when the card
appears. It would have to be introduced — a label written by the server where the created URL
first exists — before anything could count it.

`scripts/check-board-counts.mjs` pins the format down on a fixture whose sections are named
`Icebox` / `Underway` / `Shipped`, and renames them again, so nothing may key on `Todo`.
`scripts/check-board-drafts-browser.mjs` reads the header back out of a real scene after a click,
because a drop that moved the cards and left the header stale compiles just as well.

## The columns a board is expected to have

Four columns are drawn, and only **three of them are on GitHub**: `Todo`, `In Progress`, `Done`,
in that order. The fourth, `My Notes`, is drawn in front of them by the canvas and exists nowhere
else. That is a convention, not a rule this code enforces — nothing here creates, renames or
reorders a `Status` option, and a project with two options or seven still mirrors correctly. What
the convention buys is that each column answers one question, and the two moves this server writes
have somewhere honest to land:

| Column | Where it lives | What is in it | What puts it there |
| --- | --- | --- | --- |
| My Notes | the canvas | observations written by hand, not yet issues | the `+`, and nothing else |
| Todo | GitHub | issues that exist and are waiting | the server, when a research run finishes |
| In Progress | GitHub | issues an agent is working on | the server, when an implementation starts |
| Done | GitHub | closed issues | GitHub's own project workflows |

**The three GitHub columns are a maintainer's job, done on GitHub.** Not automated, and
deliberately: `updateProjectV2Field` takes the whole `singleSelectOptions` list and its input
carries no option ids, so writing one more means rewriting all of them — and every item's `Status`
is stored against an option id. A convenience that quietly cleared the board is not worth having.
The same arithmetic is why **deleting** an option is a maintainer's step too, and why #97 did not
delete `My Notes` from project 5 as part of landing: the code stopped depending on it, which is
the part that can be done safely from here.

Order still matters for the GitHub half — a project that reorders its options reorders the
columns, and their hues with them. The notes column is not affected: it is not an option, so
nothing GitHub does to that list can move it off the front or change what it is called. This is
what #97 bought. Before it, `My Notes` had to be dragged to the top of a list GitHub appends to,
and an option deleted or reordered by anyone with write access moved the `+`.

A board that names its GitHub columns differently says so in `board.config.json` rather than being
renamed to suit this page; see `projectTodoColumn` and `projectInProgressColumn` below.

## A card is an issue block

Selecting a card opens the same panel an authored block opens: the issue title, its state, its
body, and **Implement / Fix**. That is what makes deleting the draft honest — the card can do
everything the block it replaced could, so researching an issue from the board no longer ends by
taking the description and the implement button away.

A closed issue is the exception, and it is the issue's rule rather than the card's: the button
goes and what closed it is named in its place, on a card and on a block alike.
`docs/issue-block.md` has it.

It works for any card, including issues that were never drafted here. An issue opened on GitHub
appears in the mirror and can be implemented from the canvas without a block ever existing for it.

The state of an implementation lives on the **server, against the issue URL** — not in
`customData` on a shape. A card is redrawn from GitHub on every read and is kept out of the
autosync, so anything written onto one is gone on the next poll; there is nothing to write to and
no element id to name it by. Keying on the issue is also the more honest model: whether an issue
is being implemented is a fact about the issue. Two shapes standing for the same issue cannot
disagree about it, and one issue cannot become two pull requests because it was asked for through
both.

The copy on an authored block stays, mirrored from that record, for the reason the issue title
stays: a block has to read correctly with nothing selected and with no network.

A block hears the result over the WebSocket, as an element update. A card cannot — there is no
element — so while a run is in flight the panel asks `GET /api/implement`, which reads the record
and spawns no `gh`.

## A run moves its card, twice

Two transitions, both written by this server, both `moveIssueToColumn`:

- **Research finished** → the issue that came out of it moves to **Todo**. The observation was
  written in `My Notes`, which is not on the project, so the issue arrives wherever the project's
  *Item added to project* workflow puts it — a decision made outside this repository and not
  readable through the API, which is exactly why the move is worth making. Without it the landing
  column is whatever somebody configured on GitHub, and a researched issue could be
  indistinguishable from one nobody has looked at yet.
- **Implementation started** → that issue's card moves to **In Progress**. Closing and creation
  are already automated by GitHub's own project workflows; this was the one transition nobody
  wrote, which is why it was the one that drifted.

Both show up in the mirror on the next poll.

**The server writes them, not the agent.** The observations these came from named the agent,
because the agent is what the click starts, but nothing requires the write to come from that
process. An agent that dies early would leave the card where the failure is invisible, and the
state would be written by the one participant that cannot report its own crash. It would also mean
putting a project URL, a field name and a column name into a prompt whose whole design is to carry
none of them.

Which columns those are, is resolved rather than guessed:

```json
{ "githubProject": "…", "projectTodoColumn": "Ready", "projectInProgressColumn": "Doing" }
```

Unset, the options named `Todo` and `In Progress` are used, matched case-insensitively — the same
reliance on GitHub's defaults the `+` makes on the first column. **If neither resolves, nothing is
moved** and the reason is logged, naming the setting that would fix it. A board that renamed a
column gets no move until it says so, which is the deliberate half of that trade: retargeting to
some other column would put somebody's card somewhere they never asked for.

Nothing about either move may cost the run. The write is not awaited — the project and the agent
are independent, and a `gh` working through its retries must not hold a run up — and every outcome
that is not a move is a log line: no project configured (no `gh` is spawned at all), no such
column, an issue that is not on the project, a card already in that column, or `gh` itself failing.
The implementation still starts and the block still reads `created`; both routes answered 202 long
before any of this ran.

A research run that created **no** issue moves nothing, and the board is not even read: there is
nothing to move, and the block keeps its observation so it can be tried again.

The board is read uncapped for this, unlike a drag: `projectCardLimit` exists so a section does not
draw hundreds of cards, and a card hidden behind it would otherwise read as an issue that is not on
the project.

An implementation that *fails* leaves the card in In Progress. Moving it back would erase the
record that anything was attempted, and the pull request state on the card already says how the
run ended.

`scripts/check-issue-todo-column.mjs` and `scripts/check-implement-in-progress.mjs` cover the two
moves, each with a stubbed `gh` and a stubbed agent.

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
- **A card shows its number, its title, its column and whether an agent is on it.** Labels,
  assignee and the issue's own open/closed state each cost a wider query.
- **Cards from other repositories, and pull requests, are read-only.** They render; they do not
  move.
- **Order will not match GitHub's.** Items come back in `POSITION` order — whatever arrangement
  someone dragged them into — and newest-first is sorted here.
