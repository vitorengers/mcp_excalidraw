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

## Stream the issue agent into the terminal too

#128 put the **implement** agent in a tab: a run opens a session of its own in its worktree, the
strip labels it with the issue, and its output arrives while the run is alive rather than at the
end. The issue agent has the same gap and none of the work left — `runAgent` takes a `host`
(`src/core/issue-agent.ts`), the session already carries an owner and a directory, and
`runIssueAgent` simply does not pass one. `runReviseAgent`, which researches an existing issue
again, is the same run and the same omission — one seam, not two.

It was left out because researching an issue is bounded work that finishes in minutes, where an
implementation is the one that runs for an hour with nothing to look at. That is a reason to do
it second, not a reason not to do it: an issue agent that wedges is exactly as opaque as an
implement agent that wedges, and a block offering a reset is all a reader has to go on.

What its tab would not be is interactive, for the same measured reason — see `docs/terminal.md`.

## Two smaller things the map turned up

**Neither the MCP tools nor the CLI are workspace-aware.** `src/core/canvas-client.ts` never
sends `?workspace=`, so both always act on the `default` store. An agent driving the canvas over
MCP cannot target a registered project board at all — only the REST API can. That is a real gap
for a tool whose whole point is that agents draw on project boards.

**Nothing loads or saves `boardFile`.** It is resolved from `board.config.json` and returned by
`GET /api/workspaces`, and then no code reads it. Persistence is a manual export
(`scripts/export-board.mjs`) and a manual import. A board that is not exported dies with the
process — including this one.
