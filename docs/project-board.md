# Project board mirror

A region to the left of the board's own content, showing the workspace's GitHub project: one
section per column, newest issue on top — except **Todo**, which reads oldest first because it is
the column the queue drains — and cards you can drag between columns with the move travelling back
to GitHub. Dormant unless a project names a `githubProject`, so a board that has none never grows
one.

The **leftmost** region again since #200: the canvas reads `mirror | terminals | documentation`,
and the terminal blocks sit between this one and the board's own content, anchored to the
documentation while this one is anchored to them (`docs/terminal.md`). It was the middle region
between #96 and #200, with the blocks past it on the far left; the reversal re-points which of
the two is measured from the other and changes no arithmetic.

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

```json
{ "githubProject": "https://github.com/users/you/projects/5", "projectCardLimit": 8 }
```

**This project sets 8**, and that is a setting rather than a new default: 12 stays what a config
that says nothing gets. A full column of 12 is `48 + 44 + 12 + 12 x (52 + 12)` = 872 scene pixels
of canvas, which #232 measured as taller than a laptop screen holds; 8 brings it to 616 and leaves
Done as the screenful of recent history it is read as. Because the cap is per workspace, 8 is what
every column here gets — today only Done has more than 8 cards, so only Done changes, but the day
Todo fills it will draw 8 too. The queue is unaffected either way: it reads Todo uncapped
(below), so a card the cap leaves out is still a card an implementation starts from.
`scripts/check-project-card-limit.mjs` is the check for the whole path, config file to header.

An item the project holds but never gave a status lands in a **No Status** section rather than
disappearing. That section only appears when something is in it.

## Both directions go through `gh`

`src/core/gh.ts`, reusing `agentPath()` and `buildAgentCommand()` from the issue agent. No new
HTTP client and no token to store: `gh` is already required here, already carries the `project`
scope from your own login, and the two traps around it — a PATH without the CLI on it, and a WSL
project whose paths only make sense inside the distro — are already paid for.

Reading is one `gh api graphql` query returning the project id, the field, its options and the
items, because a move needs the first three and the mirror needs the last. The query is built on
one line: it travels as a single command-line argument through a tokenizer and, for a WSL
workspace, through `bash -lc`, and a string that can hold neither a quote nor a line break cannot
be broken by either. Anything interpolated into it — the owner login, the field name, every node
id, and the page cursor — is matched against a pattern first and refused outright otherwise.

**One query, asked once per page.** `items` returns at most 100, so a project past a hundred items
is read by following `pageInfo.endCursor` into `after:` until GitHub says there is no next page,
up to a ceiling of twenty pages. The pages are one answer: they are concatenated before anything
is sorted or capped, so which cards a section shows follows from the whole project rather than
from where a page boundary happened to fall. A project that fits on one page costs one call — the
cursor variable is simply left unset, and GraphQL reads an absent nullable variable as "from the
beginning".

Stopping short is not silent. `morePages` says the mirror is missing cards, whether the ceiling
ended the read or GitHub returned a cursor that could not go on a command line, and the mirror's
title strip says so on the canvas. That signal existed and was drawn by nothing for two issues,
which is how a board that had quietly stopped showing its newest cards went unnoticed
(**#206**) — the read truncated at 100 items, and with it the research run's move to Todo, the
queue's drain, and the draft block that waits for its card to appear before it retires.

Writing is `gh project item-edit --id … --project-id … --field-id … --single-select-option-id …`.
It is retried like every other `gh` call here, which is safe because setting a single-select field
is idempotent. The first real move made from this machine failed on `dial tcp` — the same socket
buffer exhaustion the issue reader already retries — and without a retry that blip reaches the
canvas as a card snapping back for no reason anyone can see.

`EXCALIDRAW_GH_COMMAND` overrides the binary, which is how `scripts/check-project-board.mjs`
answers without a GitHub account behind it. **Which binary is a question about the workspace,
not about the server**: a WSL project's calls are resolved inside its distro, where a host path
cannot exist, so it reads `EXCALIDRAW_GH_COMMAND_WSL` and otherwise the bare `gh` — never the
host's. One variable for the whole server is #252, and it is what a distro-backed board's mirror
disappearing at a restart looks like
([trap-gh-path.md](trap-gh-path.md#it-is-two-machines-and-two-binaries)).

## Polled, because there is nothing to subscribe to

`projects_v2_item` webhooks are organisation-scoped, and a user account has no hooks endpoint at
all — `GET /users/<login>/hooks` is 404 and the repository's hooks are `[]`. So the canvas polls,
every twenty seconds, and only while the tab is on screen. A run that just finished refreshes
immediately rather than waiting out the interval: that is the one moment the project changed for a
reason the canvas already knows about.

## A read that fails says so on a cold board, and is ignored on a warm one

`GET /api/project-board` answers **502 with `gh`'s own message in it** when the read fails — `gh`
unresolvable, an expired login, a token without the `project` scope, a GitHub outage, the loopback
refusal above. The server was never the quiet part. The canvas was: every answer that was not a
404 met one `return`, and on a board where the mirror is already drawn that is right, because a
blip must not wipe a region somebody is reading. On a **cold** one — nothing drawn yet — nothing
was what stayed on the screen, which from the canvas is indistinguishable from a board with no
`githubProject` at all. #252 lost a WSL board's mirror to a restart that way, and the only trace
anywhere was a line in `%LOCALAPPDATA%\Excalidraw-MCP\excalidraw.log`.

So a cold failure draws a **red strip** where the mirror would have been, carrying the sentence
the server sent, and a warm one still draws nothing at all (**#254**). `layoutUnreadable` is the
whole of it, and `placeMirror` puts it exactly where the mirror goes, so the board arriving
afterwards replaces it in place rather than beside it.

A strip rather than a toast, and `morePages` above is the precedent — *a mirror that is missing
cards says so on its own strip*. What is wrong here lasts as long as the failure does, and a toast
has come and gone ten seconds later, leaving the canvas indistinguishable again, which is the
complaint. It would also need a rule of its own to stop a twenty-second poll raising it a hundred
and eighty times an hour; redrawing the same strip is simply idempotent, and the signature the
mirror already keeps skips even that.

There is no `ProjectBoard` behind the strip — that is what failed — so it carries no link, no
columns and no count, and it is a fixed three columns wide rather than the project's. Everything
else about it is the mirror's: the `project-board` mark that keeps it off the server and out of
the export, the `docKey` that opens this document when it is selected, and `locked`, so it cannot
be dragged somewhere it no longer means anything. `customData.unreadable` is what tells it from
the strip of a board that *was* read.

**The strip is drawn again once the fonts have arrived, and that is not decoration.** Excalidraw
measures bound text when the element lands and keeps the number, so a label drawn before the
handwriting font has loaded is stored narrow and then painted with the real font and clipped to
the stored width. For the mirror that corrects itself, because the board changes and the region is
drawn again; this strip has the opposite property — the failure it reports is usually the *same*
failure every twenty seconds, so the signature skips every redraw and the clipped measurement is
the one that stays. Measured in a browser: the label was 467 wide against a sentence the page makes
510 of, and `bash: … command not found` lost a character off each end. So `document.fonts.ready`
buys exactly one more pass.

404 is untouched and still means something else entirely: the board has no project, so the region
is cleared rather than explained.

## Where the region sits

Measured **once**, against the board's own content, and then kept. The first time there is
anything on the canvas to measure against, the mirror's right edge is put one gap — 120 — to the
left of the leftmost thing the board has authored, with its top level with the topmost. From
then on that origin is what the region is drawn from: the poll re-reads GitHub, never the canvas.

It used to be recomputed on every poll from `minX - 120 - boardWidth(sections)`, storing neither
number, and that gave it two independent ways to move with nobody touching anything:

- **its own width.** Pinned by its *right* edge and drawn leftward, a column added on GitHub did
  not extend the region toward the board — it moved every column that was already there 324
  further away from it, the first one included, which is where the `+` is and where an
  observation gets written. The `No Status` section is appended only while something is in it, so
  that could happen and unhappen on its own, twenty seconds after an item lost its status.
- **the bounding box.** `minX` and `minY` were measured over *everything else on the canvas*, so
  any element added, dragged or erased anywhere that changed the scene's leftmost or topmost
  coordinate dragged the whole region along by the same delta on the next poll.

That is #99 — a region that drifted up and to the left over days, with no action to connect it to
because half of it had none.

**Which edge survives a width change is the trade this settles, and since #200 it is the right
one.** A mirror whose width is set by GitHub cannot keep both. The rule is *pin the edge the
neighbour is placed from*, and the neighbour has moved: while the blocks sat past this region on
the far left, that was the **left** edge, so a column appearing grew the region rightward, into
the gap it keeps from the board's own content. Under `mirror | terminals | documentation` the
blocks are anchored to this region's **right** edge instead, and growing that way would put a new
column on top of them. So the right edge is pinned and a column added grows the region *leftward*,
into canvas nobody is using.

What that costs is exactly the half of #99 recorded above: pinned by its right edge, the region
gets wider by pushing every column already drawn one column-width further left, the first of them
— the one carrying the `+` — included. Accepted rather than overlooked. Under this order the
alternative is a collision with the blocks rather than a shift, and a column added on GitHub is a
cause a reader can point at, which is what the drift never was.

The price is the one the terminal already pays for the same decision: a board whose content is
moved wholesale leaves the region where it was put. A reload re-measures, which is what puts it
back.

What may be measured against is one predicate, `mirrorAnchors`, stated the way the autosync and
the export state theirs: not the mirror's own shapes, or it would re-anchor to itself; not the
terminal blocks, which this region is placed *from* directly since #200 — they are handed in as
a region of their own, and one counted a second time here would be measured as content and drag
the answer a block-width further out; not the draft blocks,
which live inside the region; **not a label bound to any of those**; and — since #188 — **not
anything standing inside the region as it is currently drawn**, whatever it is marked with.
Excalidraw binds text to whatever is selected and that text carries no `kind` of its own, so a
title bound to the terminal — the one block the reader is expected to drag — looked authored, and
dragging it up and to the left moved the mirror while the block itself was ignored.

That last exclusion is the only one that is geometry rather than a mark, and it is there because
every other one can be lost. A draft is excluded by `projectBoardDraft`; a block written in the
notes column that never carried the mark, or lost it, is on those terms an ordinary authored
shape that happens to sit inside the mirror. Measured against it, the region lands one mirror
width further left — on top of the terminal — and that origin is a *measured* one, so it is
remembered and stays. A shape inside the region cannot say where the region goes: it is there
because of where the region already is.

`scripts/check-mirror-anchor.mjs` has the arithmetic and
`scripts/check-mirror-anchor-browser.mjs` drives a real Chrome across a poll that adds a column,
because the whole question here is what a poll does to a placement.

### The board that has nothing to measure against

A board holding only a mirror and a terminal has an **empty anchor set on every poll** — both
regions are excluded by the predicate above, and there is nothing else. That used to be answered
with `{ x: -(mirrorWidth + 120), y: 0 }`, an absolute coordinate that knows nothing about the
board, is not worth remembering, and is therefore decided again every twenty seconds. Since the
width in it is GitHub's, a column added to the project moved the region a column-width further
left on the next poll — onto a block anchored to where the region used to be. That is #188, and
it is the same shape of defect as #99 on a board that never had any content to drift relative to.

**The block is what such a board is measured from** — and since #200 that is true of every
board, not only this one. The region goes one `MIRROR_GAP` left of the blocks' left edge, which
is one step of the chain `terminalOrigin` starts from the documentation rather than a second
derivation of the same number. That is what makes it a fixed point: the blocks do not move
because the region was placed here, because the region was placed from the blocks. It is a
measurement, so it settles, and the poll after it never takes it again. It read
`terminal.maxX + TERMINAL_GAP` until #200, the block being *outside* the region then; the sign is
the whole of the difference.

**A remembered answer the blocks are now standing in is dropped, and measured again.** On a board
with a project and no shell open, this region is measured from the content and lands in the slot
the first block will take — a session opens on a `POST` while a board arrives on a poll, so that
is the ordinary order. When the block lands there the remembered answer describes a board that no
longer exists, so it is thrown away and the region re-measures around the blocks. Once, on a
collision, and it cannot fire twice: what it settles on is a gap clear of them. It is visible —
the region steps a block's width left at the moment a shell is opened — and that is the same
standard as above, a move with a cause over a drift without one.

Only a board with **neither** content nor a block falls back to the constant, and that one is
still not remembered.

**And where each region went is kept per board, across a switch away and back.** It used to be
one value dropped on every switch, which made coming back a fresh decision taken against whatever
the canvas looked like at that moment — on a board of this kind, nothing at all. Keyed by
workspace instead, so the next board's content still cannot decide this one's placement, which is
what the reset was actually for. A reload is what re-measures, the way it is for the terminal.

`scripts/check-mirror-terminal-drift-browser.mjs` is the one that asks this in a browser: a board
holding only those two, across ten refreshes and a real twenty-second poll, a column appearing, a
shape dropped inside the region, and a switch away and back. The region's **pinned edge** has to
be where it was first drawn each time, and the two bounding boxes must never intersect.
`scripts/check-canvas-order-browser.mjs` is the one that asks about all three regions at once.

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

**And the rule reaches the blocks in the notes column, which are the one population it used to
miss.** A block takes its colours from its stage rather than from a column, and everywhere else
the two populations sit apart — but the notes column stacks them under one header, and a yellow
block under a blue bar read as a mistake (#195). The block's first stage is now that header's own
stroke and that column's own tint, `#1971c2` on `#e7f5ff`, with the stage still carried by the
outline and by one step down the ramp (`docs/issue-block.md`). The mirror still paints no drafts
— the layout only *places* them, geometry and nothing else — so this is a constant in
`src/core/issue-appearance.ts` rather than a column being consulted, and
`check-notes-block-hue.mjs` reads the header's stroke out of the layout to hold the two together.
A block becoming a card therefore becomes a visible move between hues: a created issue is dropped
into Todo, which is the next column and the next stroke along.

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

**Every draft is drawn in the notes column, and the stamp it carries decides nothing**
(`layoutMirror`). That is the one rule #97 reverses rather than adds. `layoutBoard` still leaves a
block where its `sectionOptionId` says: none of the project's columns is where it *belongs*, only
where it might be guessed to. The notes column is where it belongs by construction — every draft
was written as an observation.

Keyed on "the board no longer has this column" for one release, which caught half the population
and missed the half that is harder to see. A block carries whichever column the `+` was on when it
was clicked, written once and never again, so while that column was an ordinary option any change
to the project's **ordering** stranded every block already written — with a stamp naming an option
that is still perfectly real. Adding `My Notes` in front of `Todo` did exactly that on project 5:
three observations written beforehand kept `f75ad846` and were drawn among the issues in `Todo`,
where the whole contract is that a card is an issue that exists. Nothing could move them either —
`settleMirrorDrag` rewrites a column for mirrored cards and nothing else, so dragging one moved it
until the next relayout and no further. That is #117.

So `sectionOptionId` on a draft is now **vestigial**: written by the `+`, overruled by the layout,
and read by nothing that decides anything. It is left on the element rather than rewritten there,
because a correction that had to be *written* is a correction that can fail, be refused, or lose a
race with the autosync — and this one cannot. Nothing about a draft's column has to reach the
server to be true on screen.

The name `My Notes` is the one column name in this repository that is a constant, and it has to
be: every other name is GitHub's because every other column is GitHub's.

The block comes from the library (`docs/blocks.excalidrawlib`, through `GET /api/library`) rather
than being built here, because what makes a block functional is `customData.kind` and a second
definition of that shape would drift from the one the library ships. It is marked
`projectBoardDraft` and is a **real, authored** element: it persists, it syncs, and it is yours
until the issue exists. The mirror leaves room for it at the top of its column.

### One unwritten block at a time

The `+` makes a block only when there is no **unwritten** one already in the column. Where there
is, that block is selected instead and no second one is made. A double click therefore leaves one
block, and so do five presses — before #135 they left two and five, each of which had to be
deleted by hand.

The `+` is a shape rather than a button, and this follows from that: the click on it is the
selection landing on it, and the handler hands the selection straight back to the block it just
made, which re-arms the shape for the very next press. Nothing gave a "done" signal either, and
the block appears at the top of the column behind a mirror redraw — so a reader who pressed again
because nothing seemed to have happened was answered with another empty block.

**Unwritten** is read off the element, not off a flag. The label still says what the library ships
(`Write the observation here`, compared on one line so a narrower column's wrapping does not read
as an edit), and the block carries no `customData.issueUrl` and no `customData.issueState`. A flag
would be a second copy of the answer that every place that can edit the text would have to
remember to clear; the text is what the reader is looking at, so the text is what is asked.

The cap is on unwritten blocks only, and never gets in the way of real work. An observation that
has been typed into is somebody's, and so is one a research run has already turned into an issue,
so in both cases the `+` still owes the reader a fresh block. And every draft on the canvas is
considered, not only the ones stamped with this column — the stamp is vestigial, the layout draws
every draft here whatever it says, so reading it would let a block stranded by an old ordering
hide from the cap.

`scripts/check-notes-add-once-browser.mjs` drives all of that in a real browser. It also asserts
that `Ctrl+Z` after one press leaves **no** block and brings none back: `selectedElementIds` is
part of Excalidraw's observed app state, so an undo restores the selection along with the
elements, and a selection that arrives without a press is the one way a cap could not help — there
is no block left for it to find. Undo turns out to restore the selection to what it was *before*
the press rather than to the `+`, so nothing fires; the case is kept because that is a property of
Excalidraw's history, not of this code.

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
without `EXCALIDRAW_LIBRARY`, the library came back empty, and `addIssueBlockToColumn` returned
when no template carried `customData.kind === "issue"`. Every click was a silent no-op, so the
ordering assertions had never reached the thing they were about. Silent to a console nobody had
open, at that — which is the half of it that is fixed below.

### A press, and never a selection left behind

The `+` is answered by *selection*, which is the whole of #244: a locked shape cannot be clicked
in Excalidraw 0.18 — there is no activation affordance for one — so the button has to stay
unlocked, and the press it reads is `selectedElementIds` arriving on it. Two things follow, and
neither was true before.

**A selection is a press only when the button is alone in it.** The header rectangles are locked
and no rubber band catches them, but every card, every draft and both buttons are unlocked, so one
band across the header strip or one shift-click puts the `+` in a selection nobody pressed it in.
That used to resolve the whole selection to "no single shape" and do nothing at all, leaving the
button showing an ordinary selection box — the report's "it is selecting as a block". It is now
taken *out* of the selection instead, and what the reader actually selected stays selected and
stays described by the panel. The queue toggle is handled by the same lines, and a selection is
still not a press for it either: sweeping it up does not flip the queue.

Not while the gesture is still running, though. A rubber band is redrawn on every pointer move and
would put the button straight back, so the button is shed on the selection the reader ends up
with, once `selectionElement` is gone.

**A press is answered even when it can do nothing.** `syncSelectedDoc` ignores a selection that
has not changed — it must, or every pointer move over the button would drop another block — so a
path that returned with the `+` still selected made the *next* press an unchanged selection, and
the button was dead until something else was clicked. Every return out of `addIssueBlockToColumn`
was such a path. The selection is now dropped first, before anything that can go wrong does, which
is the rule the queue toggle was written with and states in the same words.

The reachable one of those returns is a **library that ships no issue block**, and it warned to a
console the reader does not have open. It now says so on the canvas as well, through Excalidraw's
own toast, which is a sibling of the canvas rather than a shape drawn into it — so the message
does not have to be cleaned up, exported around or synced to anyone. `docs/shared-library.md` is
where that configuration lives.

**A `+` dragged out of its header is put back by the next refresh**, which is what
`project-board-layout.ts` has always claimed and nothing did until #244. The redraw is skipped
when the layout has not changed, and the layout is computed from what it *wants* — so a mirror
whose `+` had been nudged onto the empty canvas matched, was skipped, and stayed there. The skip
now asks where those two shapes actually are first. Only those two: everything else on the mirror
is locked and can only be where the last redraw put it.

`scripts/check-notes-add-press-browser.mjs` drives all four in a real browser, the last of them
against a second board whose workspace library is the shipped one with the issue block filtered
out.

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

"On the server" is right about *where* and says nothing about *how long*: on the server means in a
`Map`, and the map does not outlive the process. A run killed with its server used to come back as
nothing at all. It now comes back as `interrupted`, read off the worktree it left behind rather
than restored from anywhere — see **A run that lost its server** in
[issue-block.md](issue-block.md).

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

**Both are looked up in a board that has been read, so both are only as complete as that read.**
Neither move names an item id — they find the card by its issue URL — so a card the read did not
reach is a card that cannot be moved, and `moveIssueToColumn` says "is not on this project" about
an issue that plainly is. That is what stranded #199 and #200: the read stopped at 100 items, the
research run's move to Todo was a no-op, and the draft block in `My Notes` never saw a card to
retire against. Paging is what makes the guarantees above hold on a project of any size the
ceiling admits; past the ceiling they hold for what was read, and the mirror says it is short.

**The server writes them, not the agent.** The observations these came from named the agent,
because the agent is what the click starts, but nothing requires the write to come from that
process. An agent that dies early would leave the card where the failure is invisible, and the
state would be written by the one participant that cannot report its own crash. It would also mean
putting a project URL, a field name and a column name into a prompt whose whole design is to carry
none of them.

That argument holds and its assumption does not cover everything: it protects against the *agent*
dying, not against the server dying. When the server is what dies, the participant holding the pen
is the one that cannot report the crash, and the card is left in **In Progress** with nothing
behind it. Detecting an interrupted run does **not** move it back. A stranded card is wrong, but a
card that walks backwards on its own while somebody is looking at the board is worse, and the
panel is where the run is reported.

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

## The queue toggle

The **Todo** header carries a circular arrow at its right, where the notes column carries the
`+`. On, and the server starts the oldest issue in Todo every time an implementation slot frees;
off, and nothing starts unless somebody clicks it. What it does is `docs/issue-block.md`'s to
describe — the cap it defers instead of refusing, what it skips, and why it lives on the server.
Three things about the button belong here.

**It is a shape, and it is unlocked**, exactly like the `+`: a locked shape cannot be clicked, and
this one is a button. The header rectangles around it stay locked. It is handled as a *selection*
rather than as a click, and the selection is dropped as soon as it is read — a toggle left
selected could never be switched back, because a selection that has not changed is ignored. A
selection it arrives in *with company* is not a press at all, and it is taken out of that
selection rather than left sitting in one; [the `+`](#a-press-and-never-a-selection-left-behind)
is where both halves of that are written down, because both buttons go through the same lines.

**Three states, and they differ in fill, in weight and in whether the outline is whole — not in
hue.** Hue on this mirror already means the column and, on a failed move, an error; a fourth
meaning would collide with both, and a difference only a colour carries is one some readers do
not get.

| The toggle | What it is saying |
|---|---|
| White, thin outline | Off. Nothing starts unless somebody clicks a block. |
| The column's own stroke, filled solid, heavier outline, glyph reversed out of it | On, and the last pass did what it was switched on to do — it started runs, or the column had nothing left in it to start. |
| The same, with the outline **broken** | On, and the last pass could start nothing. |

The broken outline is #263: on drew the same whether the queue was working or walled in, so a
board with four wedged runs holding every slot and two cards waiting in Todo looked exactly like
a board that had finished. A dashed outline already reads on this mirror as *not settled* — it is
what a card whose run is in flight carries — and a button meant to be going round with its
outline broken is the same sentence.

**Why it stalled is a sentence, not a shape.** Twenty-eight pixels cannot hold "all 4 slots are
taken, by these issues", so the board says it as a **toast**, the first time the reason changes,
and repeats it only if it changes again — a stall stalls on a timer, and a toast per poll would
be the board saying the same thing every twenty seconds until somebody switched it off. The
sentence is composed by the server and also available as `queue.lastPass.detail` from
`GET /api/implement`; `docs/issue-block.md` lists the reasons.

**The state is the server's and arrives with the poll.** It rides on the same `GET /api/implement`
that brings the run marks, and is never read back off the shape: every mirrored element is thrown
away and redrawn from GitHub on each poll, so a switch that kept its state on the button would
last exactly one refresh. That is the same reasoning that keeps implement state against the issue
URL. When implementing is disabled, or the server is not on loopback, the answer carries no queue
at all and no toggle is drawn — a button that cannot do anything is worse than no button.

`scripts/check-implement-queue-browser.mjs` covers the button's two clicks and the two states a
switch has; `scripts/check-implement-queue-newcard-browser.mjs` covers the third — a card
arriving on GitHub while the page is open, the cap filling behind it, and the outline breaking
with the reason said out loud.

### Todo is drawn oldest first

Every other column keeps newest-on-top. Todo does not, because it is the column the queue drains
and the queue takes the oldest first: drawn newest-first, the card at the top would be the one
starting *last*, and the one starting next would be at the bottom — with the card limit, often
off the board entirely. A column that reads backwards from what the board is about to do is worse
than a column that disagrees with its neighbours.

Only that column, and only the one the workspace names (`projectTodoColumn`, `Todo` by default,
matched case-insensitively). Flipping every column would move the truncation to the other end of
each of them: a long `Done` would start hiding its **newest** cards, which is the opposite of
what the limit is for. The sort runs before the cap, so which cards the cap leaves out follows
from the order rather than the other way round.

The queue itself never reads the drawn board. It reads the column uncapped, so what is *drawn*
and what is *started* cannot disagree about anything but how much fits on screen.

## The hotkey

**Alt+B** scrolls the viewport onto the mirror. `Alt` because Excalidraw owns the bare letters —
every tool has one — and much of `Ctrl+Shift`. It is matched on `event.code`, so it survives a
keyboard layout where Alt produces a different character, and it is bound on `window` rather than
on the canvas, because the canvas never sees a key pressed outside it.

It stands down while text is being edited. Excalidraw edits labels in a real `<textarea>`, so what
has focus is the honest test — and it is what keeps this from swallowing a keystroke meant for a
card's title.

The one focused `<textarea>` it does **not** stand down for is the terminal, which reads the
keyboard through a hidden one of its own. Since #177 this key reaches the board from inside a
focused shell, and the shell is not sent it either; `frontend/src/board-hotkeys.ts` is the rule
and [terminal.md](terminal.md) is why.

### Where it lands

**At the top of the region, never in the middle of it.** The region is fitted to the canvas, but
never below the zoom the board was written at ([board-sections.md](board-sections.md) has that
floor and why it exists), so on a short enough canvas the region is drawn taller than there is
room for. What is left over is placed at the bottom: the title strip and the column headers are
on the screen, and the last cards of the longest column are below the fold and scrolled to.

The other way round is #232 — reported from a Mac as the region going "to back of the top bar",
and it was the top of the region rather than any bar. Excalidraw centres the bounds it is given,
so the overflow was split half above and half below, and the half above is exactly what a reader
presses the key to see. Nothing about it is platform-specific: it is canvas height alone, and a
full `Todo` column is around 900 scene pixels — taller than a laptop canvas, shorter than a
maximised desktop one, which is why the same key behaves differently on two machines.

**Under Excalidraw's own menus, not behind them.** The toolbar, the hamburger and the properties
island are painted *over* the canvas rather than beside it, and two of the three sit in the
top-left corner, which is the corner this region is drawn in. The fit reserves what they cover,
measured off the rendered nodes because the island's height depends on what is selected. With
`Hide Menus` on there is nothing to reserve and the region uses the whole canvas.

`frontend/src/board-fit.ts` is the arithmetic — it is `canvasOffsets` on Excalidraw's own
`scrollToContent`, so the animated pan is unchanged — and
`scripts/check-board-landing-browser.mjs` asserts it at two canvas heights, with the menus shown
and hidden. `Alt+P` and `Alt+G` land by the same rule; they share the same fit.

## What it does not do yet

- **2000 items**, twenty pages of a hundred, is what one read follows. A ceiling rather than
  "until GitHub runs out" because the read is on a poll — every 20 seconds, and again for the
  queue — so an unbounded loop would turn one board into an indefinite number of `gh` calls per
  tick. Past it the mirror's own title says how many it drew and that the project has more.
- **A card shows its number, its title, its column and whether an agent is on it.** Labels,
  assignee and the issue's own open/closed state each cost a wider query.
- **Cards from other repositories, and pull requests, are read-only.** They render; they do not
  move.
- **Order will not match GitHub's.** Items come back in `POSITION` order — whatever arrangement
  someone dragged them into — and the order is sorted here: newest-first everywhere except Todo,
  which is oldest-first because that is the order the queue starts them in.
