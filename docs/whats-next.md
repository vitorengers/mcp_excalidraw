# Next

## An automated browser test

The UI layer is verified by hand today. That is not a stylistic complaint: three real defects
here **compiled cleanly, type-checked, and did not work** —

- a documentation panel that never opened,
- a race in tab startup,
- a click landing on the label instead of the box it belongs to.

Nothing short of driving a real browser would have caught any of them. Every server-side
behaviour has a `scripts/check-*.mjs`; the frontend has none, and it is where the blocks
actually live.

## Stream the agents into the terminal

The terminal (`docs/terminal.md`) is a surface that carries a byte stream over the WebSocket and
draws it on the board. What it does not yet carry is the output of the two agents this board
already spawns — and that was the destination the observation behind #51 actually named. The
terminal was the step it asked for first.

It is a small change on the server and deliberately not part of building the surface: `runAgent`
already receives the chunks (`src/core/issue-agent.ts`), and today it accumulates them and reads
the result once the process exits, which is exactly why a block can say a run is `running` and
nothing more. Broadcasting them makes the agent a second producer on a surface that exists.

The open question was whose terminal it is, and #94 answered most of it: a board holds up to
eight sessions, each addressable by id on every route and in every message, so an agent gets a
**tab of its own** rather than interleaving with the session somebody is typing in. What is left
is narrower — a session the server opened for an agent is one nothing typed into, so it wants a
tab that says so rather than an `s4` indistinguishable from a shell the reader started.

## Two smaller things the map turned up

**Neither the MCP tools nor the CLI are workspace-aware.** `src/core/canvas-client.ts` never
sends `?workspace=`, so both always act on the `default` store. An agent driving the canvas over
MCP cannot target a registered project board at all — only the REST API can. That is a real gap
for a tool whose whole point is that agents draw on project boards.

**Nothing loads or saves `boardFile`.** It is resolved from `board.config.json` and returned by
`GET /api/workspaces`, and then no code reads it. Persistence is a manual export
(`scripts/export-board.mjs`) and a manual import. A board that is not exported dies with the
process — including this one.
