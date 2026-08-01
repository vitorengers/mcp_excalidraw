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

## Neither the MCP tools nor the CLI were workspace-aware

`src/core/canvas-client.ts` never sent `?workspace=`, so both always acted on the `default` store
and an agent driving the canvas over MCP could not target a registered project board at all —
only the REST API could. That was a real gap for a tool whose whole point is that agents draw on
project boards, and it is closed since #344: `--workspace <id>` on any CLI command, an optional
`workspace` argument on every MCP tool that reaches a canvas, and `EXCALIDRAW_WORKSPACE` for a
whole session. What is left of the question is what "none named" should mean, and the answer
chosen is in [workspaces.md](workspaces.md): one registered project is that project, none is
`default`, several is a refusal that lists them.

## Nothing *saves* `boardFile`, and nothing is going to

#184 landed the load half: a registered project's board file is read into its store at startup, so
the three boards that declare one come up drawn instead of empty and the ad-hoc import is gone. See
[element-store.md](element-store.md).

The asymmetry this section named — the board remembering only as far back as the last export
somebody remembered to run — is closed since #225, and not by writing to `boardFile`. The argument
against that stands and is the reason: a board file is a tracked artifact and a commit like any
other, and a process writing to one on a timer would put diff noise into somebody's working tree.
Every registered board is instead saved beside the registry that lists it, a second after every
change, and read back before the board file at startup. Getting a board into its *tracked* file is
still `node scripts/export-board.mjs --workspace <id>`, run by hand against a running server, and
still a commit like any other.

What is left of the asymmetry is images: neither the export nor the save carries `scene.files`, so a
pasted image comes back after a restart as an element whose file the process no longer holds.

This was also the loose end behind the mojibake #151 was opened about: a canvas was seen holding a
scene fifty merges older than the tracked file, with its em dashes and middle dots corrupted, and
the only way that scene could have got there is an ad-hoc import of a historical revision. That is
the half now closed — a board that loads its own file needs no import.

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
