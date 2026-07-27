# Development log

What this fork has landed, and what was decided while landing it. Newest first.

This is the development half of the board. The other half — `1 · How the pieces fit`,
`2 · The blocks on the canvas`, `3 · Try it` — is the **Project structure** map: what the tool
is made of, right now, undated. This one is the record of how it got that way, and every row
carries the date it landed on.

It replaces `delivered.md` and `open-work.md`, which said the same thing about a smaller
repository and then stopped. `delivered.md` still opened with "Issues #1–#11, all closed" when
`main` was past #83; `open-work.md` still called #20 and #21 the open work. A document that has
to be rewritten to stay true gets rewritten once and then never again — a log that is only ever
appended to does not have that failure mode. What is still *ahead* is not here: that is
[whats-next.md](whats-next.md), and it is forward-looking on purpose.

## Adding an entry

One row per merged pull request, at the top of the table, before the pull request is merged:

| Date | Issue | PR | What was decided |
|---|---|---|---|

- **Date** — ISO 8601, the day it lands.
- **Issue** — the issue the branch was cut for, or `—` for the handful of early changes that
  went straight to a pull request.
- **PR** — the pull request. It is written before the merge, so the log runs one entry ahead of
  `git log`; `scripts/check-board-map.mjs` only fails the other way round, on a merge with no
  entry.
- **What was decided** — the decision, not the diff. `git log` already has the diff.

A change that also moves the architecture — a file, a route, a block kind or a feature added or
removed — updates the **Project structure** map on the board as well. `CLAUDE.md` is where that
rule lives.

## Entries

| Date | Issue | PR | What was decided |
|---|---|---|---|
| 2026-07-27 | #79 | #83 | A column's count is what it holds, and a draft is held: the number beside a column counts drafts too, so a block dropped by the `+` stops being invisible to the header above it. |
| 2026-07-27 | #78 | #81 | Enter finishes an observation and Shift+Enter breaks the line. Excalidraw's own label editor takes Enter as a newline, so the block needed its own answer rather than a button nobody presses. |
| 2026-07-27 | #77 | #80 | The implement agent researches too. Both agents are pointed at the project's own record for anything the repository does not settle, rather than one of them guessing from the prompt. |
| 2026-07-27 | — | #76 | The agent that was asked for is the agent that runs. Creating and finishing an issue stopped falling back to a default when a specific one had been named. |
| 2026-07-27 | #68 | #74 | An issue read once is remembered, and a mirrored card keeps the run drawn on it. The mirror redraws from GitHub on every read, so the run state is written onto the card as it is drawn rather than fetched a second later — the shape under the pointer already knows. |
| 2026-07-27 | #67 | #73 | A run says how long it has been going and what it has spent. The two instants are stored, not the duration: the clock runs in the browser, so the server writes twice rather than once a second. |
| 2026-07-27 | #69 | #72 | `draftCreatedAt` survives the round trip, asserted in a browser rather than inferred from a passing type check. |
| 2026-07-27 | #51 | #71 | The board gets a terminal on its right, running in the project. The block is derived: it exists for as long as the shell does, so it is stripped from the autosync and from the export instead of being saved. |
| 2026-07-27 | #58 | #70 | A screenshot on the clipboard can be pasted onto an issue block. Attachments are an explicit list on the block, not Excalidraw group membership — grouping for layout must not silently change what the agent sees. |
| 2026-07-27 | — | #66 | A worktree stops emptying the project's `node_modules`, and the mirror's `+` takes a click again. |
| 2026-07-27 | #64 | #65 | The implement agent is told its base can move: other implementations run at the same time, so the default branch is usually not where it was when the branch was cut. |
| 2026-07-27 | #54 | #63 | The state of the work is drawn on the board. A dashed outline is a run in flight, a solid one a run that finished — the board says what is happening without anything being opened. |
| 2026-07-27 | #53 | #61 | The issue block's action row splits: **Add observations** beside **Implement / Fix**, so adding to an issue is not the same gesture as starting work on it. |
| 2026-07-27 | #55 | #62 | Drafts stack newest-first and the column reflows as one grows, which is the order the mirror already uses for issues. |
| 2026-07-27 | #57 | #60 | The ceiling comes off the issue agent, and the block gets a way back from a run that failed. A timeout that kills a working agent leaves an issue created and a block that says it was not. |
| 2026-07-27 | #50 | #59 | Starting an implementation moves the issue to **In Progress** on the GitHub project, so the board and the project agree without anyone dragging a card. |
| 2026-07-27 | #49 | #56 | Every implementation gets its own git worktree, cut from the default branch, at `<project>-worktrees/issue-<n>`. Parallel runs in one checkout cannot each hold a branch. |
| 2026-07-27 | #46 | #52 | Reference images attach to an issue block and travel with the run. |
| 2026-07-27 | #47 | #48 | A mirrored card is a working issue block. The block and the card are drawn by different code and stored in different places, but a reader who can act on one should be able to act on the other, so the panel resolves both to the same thing. |
| 2026-07-26 | #25 | #45 | The GitHub project board is mirrored on the canvas, on the left, with two-way sync. Columns come from GitHub rather than being declared here, and the mirror is never saved — a saved column is a snapshot of someone's Todo from whenever the export ran. |
| 2026-07-26 | #43 | #44 | An implementation runs as long as it takes, and the block has a way back from a failure. |
| 2026-07-26 | #41 | #42 | An issue is implemented from the block that opened it, so the board is where work starts as well as where it is written down. |
| 2026-07-26 | #39 | #40 | The close button gets its own row and the card doubles in width. |
| 2026-07-26 | — | #38 | The block records that it holds its title. |
| 2026-07-26 | #36 | #37 | The card closes when the shape is deselected. The fix was to make the panel one function returning one answer, including "nothing": the defect was a branch that cleared the document and returned, leaving half the card pointing at a shape nobody had selected. |
| 2026-07-26 | #34 | #35 | The font size the title was laid out for is written down, so the layout is reproducible rather than re-derived. |
| 2026-07-26 | #20 | #33 | The documentation is anchored to the block, not to the window. Excalidraw's `<Sidebar>` is pinned to the window edge by CSS and `docked` only decides whether it pushes the canvas, so on a wide board a block sat thousands of pixels from its own documentation. The anchored card replaces the sidebar rather than coexisting with it — a mode switch nobody asked for is a setting to maintain forever. |
| 2026-07-26 | — | #32 | A retitled block is recorded at its corrected size. |
| 2026-07-26 | #30 | #31 | The title is laid out *inside* its block rather than merely into it. |
| 2026-07-26 | #28 | #29 | A failing `gh` is retried instead of being shown as an error: it fails intermittently here with socket-buffer exhaustion, and the first failure is usually not real. |
| 2026-07-26 | — | #27 | The issue a block produced is shown on the block. |
| 2026-07-26 | #23 | #24 | The tool is mapped on its own board, `docs/board.excalidraw`, with a card per document. |
| 2026-07-26 | #21 | #22 | Every development artifact is written in English, enforced by `scripts/check-english-only.mjs`. The convention had leaked twice — Portuguese fixtures in the check scripts, and an issue the agent wrote entirely in Portuguese after reading a repository that documented in it. The prompt now fixes the output language rather than leaving the agent to take it from what it just read. |
| 2026-07-26 | — | #19 | The issue block works end to end against a real repository. |
| 2026-07-26 | — | #18 | The observation is read from the shape's label, which is where it was already being written. |
| 2026-07-26 | #11 | #17 | The issue block: an observation written on the board becomes a researched GitHub issue. |
| 2026-07-26 | #10 | #16 | The collapsible image block. `customData.collapsed`, with `fullSize` stashed before shrinking so expanding is not a guess. |
| 2026-07-26 | #9 | #15 | `GET /api/library` serves the environment `.excalidrawlib` plus the project's own, so the blocks that make a board work are on every board. |
| 2026-07-26 | #8 | #14 | Board tabs, and a docs panel that knows which workspace it is in. |
| 2026-07-25 | — | #13 | Element storage is scoped to a workspace: `elements` stopped being one global `Map` and every route resolves its store from `?workspace=`. |
| 2026-07-25 | #7 | #12 | A workspace registry, so a board can belong to a project. One `board.config.json` per project, and the Windows and WSL spellings of a path collapse onto one key. |
| 2026-07-25 | #3 | #6 | The documentation panel: a shape carrying `customData.docKey` opens the markdown behind it from `GET /api/docs/:key`. This is the mechanism the whole board is built on. |
| 2026-07-25 | #2 | #5 | `link` and `customData` are accepted by the create and update schemas. Both were dropped there but survived a sync — an asymmetry that stopped an agent from binding a shape to its documentation through the API at all. |
| 2026-07-25 | #1 | #4 | `POST /api/elements/sync` reconciles by version instead of clearing and rewriting. Absence used to mean deletion, so anything created through the API vanished on the next autosync. The merge is by `id`, highest `version` wins, `versionNonce` breaks the tie, and a deletion travels as an explicit tombstone. |

## The pattern under the first eleven

Three of the first eleven issues were the same shape of bug: two writers to one store, with no
rule for what happens when they disagree. Clear-and-replace sync (#1), schemas that dropped
fields another path accepted (#2), and a global `Map` shared by every board (#8). The fix each
time was to make the rule explicit rather than to make one writer back off.

That is still the rule the newer half of this log follows. The mirror and the terminal are the
same problem read the other way: they have exactly one writer, so they are marked *derived* and
never stored at all.

## The habit that keeps costing

Every behaviour change here ships with a `scripts/check-*.mjs`, run against the old code first.
The ordering is not ceremony. Three defects in the UI layer — a panel that never opened, a race
in tab startup, a click landing on the label instead of the box — compiled, type-checked, and
did none of what they claimed. Nothing short of driving a real browser would have caught any of
them, which is why the browser checks exist and why `CLAUDE.md` says compiling is not working.
