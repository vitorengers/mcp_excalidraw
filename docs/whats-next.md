# Next

What has not shipped. The record of what has is [development-log.md](development-log.md), and
the map of what exists is the Project structure half of the board.

Until #151 the top of this page — and the most prominent card in the Development section —
asked for an automated browser test, describing a frontend with no checks at all. There are 23
tracked `check-*-browser.mjs` scripts, the oldest of them more than fifty merges old. The most
forward-looking statement in the documentation was a description of work that had already
landed, which is the failure this page exists to avoid; `scripts/check-docs-counts.mjs` and its
siblings now hold the numbers, but nothing can hold a stale paragraph except rewriting it when
it stops being true.

## Stream the agents into the terminal

The terminal ([terminal.md](terminal.md)) is a surface that carries a byte stream over the
WebSocket and draws it on the board. What it does not yet carry is the output of the two agents
this board already spawns — and that was the destination the observation behind #51 actually
named. The terminal was the step it asked for first.

It is a small change on the server and deliberately not part of building the surface: `runAgent`
already receives the chunks (`src/core/issue-agent.ts`), and today it accumulates them and reads
the result once the process exits, which is exactly why a block can say a run is `running` and
nothing more. Broadcasting them makes the agent a second producer on a surface that exists.

The open question was whose terminal it is, and #94 answered most of it: a board holds up to
eight sessions, each addressable by id on every route and in every message, so an agent gets a
**tab of its own** rather than interleaving with the session somebody is typing in. What is left
is narrower — a session the server opened for an agent is one nothing typed into, so it wants a
tab that says so rather than an `s4` indistinguishable from a shell the reader started.

## Neither the MCP tools nor the CLI are workspace-aware

`src/core/canvas-client.ts` never sends `?workspace=`, so both always act on the `default` store.
An agent driving the canvas over MCP cannot target a registered project board at all — only the
REST API can. That is a real gap for a tool whose whole point is that agents draw on project
boards.

## Nothing loads or saves `boardFile`

It is resolved from `board.config.json` and returned by `GET /api/workspaces`, and then no code
reads it. Persistence is a manual export (`scripts/export-board.mjs`) and a manual import. A
board that is not exported dies with the process — including this one. `src/core/workspaces.ts`
is where the field is produced and where it stops.

This is also the loose end behind the mojibake #151 was opened about: a canvas was seen holding a
scene fifty merges older than the tracked file, with its em dashes and middle dots corrupted, and
the only way that scene could have got there is an ad-hoc import of a historical revision. A
board that loaded and saved its own file would not need one.

## The documentation rebuild, past the root cause

#151 landed the checks and the facts they hold: `docs/` scanned for language and for byte
validity, the counts derived from `src/`, `README.md` about this fork, an index, and the run
procedure tracked. What it deliberately did not do:

- **Split the three oversized reference documents.** `issue-block.md`, `terminal.md` and
  `project-board.md` are 145 KB between them and narrate superseded revisions — "it was on the
  right until #96", "until #115 the block was dark" — instead of describing the present. That
  narration belongs in [development-log.md](development-log.md), where the dated record already
  is.
- **Document the surfaces that have none.** The WebSocket protocol broadcasts far more message
  types than `docs/` names; `src/core/obsidian-md.ts`, `src/core/share-url.ts` — the only
  outbound network call in the product — and `src/core/design-guide.ts` appear only as bare
  tokens in a table cell.
