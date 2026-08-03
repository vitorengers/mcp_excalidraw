# The architecture, in one page

What is in each directory, and one press on an issue block followed all the way to the coding
agent it spawns. Nothing here is new — it is the map the board already draws in its
**Project structure** half, which `Alt+P` scrolls onto, written out so that it reads from a
clone with no server running. [index.md](index.md) is the catalogue of everything else;
this is the page to read before it.

## The shape of it

The board's `1 · How the pieces fit` row, as text:

```
        three ways in, one process behind them

  src/index.ts        src/bin.ts          frontend/
  MCP over stdio      the CLI             the canvas in a browser
        |                 |                    |
        |  HTTP           |  HTTP              |  HTTP + WebSocket
        +-----------------+--------------------+
                          |
                          v
                    src/server.ts
                    Express: every route, and the only
                    surface that knows about projects
                          |
          +---------------+----------------+
          v                                v
  core/workspaces.ts                core/element-store.ts
  which project a request is        one Map of elements per
  about, from the registry          workspace, in memory
                          |
                          v
                    src/core/
                    the work itself: the issue agent, the
                    implementation, the project mirror,
                    the terminal, the settings
                          |
                          v
                    a coding agent, in a git checkout of its own
```

Only the server holds state. The MCP server and the CLI keep none of their own: both talk
HTTP to the same routes the browser uses, through `src/core/canvas-client.ts`, and both will
start a server if there is not one already. That is why the same drawing can be made by an
agent over stdio, by a command in a terminal and by a hand on a canvas, and why nothing has
to be reconciled between three copies of it.

## Every directory, and what is in it

| Directory | What it holds |
|---|---|
| `src/` | The three entrances: `src/index.ts` (MCP over stdio), `src/bin.ts` (the CLI), `src/server.ts` (Express and the WebSocket). `src/types.ts` is the shared element shape, `src/utils/logger.ts` the one logger. |
| `src/core/` | Everything neither an entrance nor a screen: the workspace registry, the element store, the issue and implement agents, the worktrees, the project mirror, the terminal sessions, the settings. Imported by all three entrances, which is what keeps them from disagreeing. |
| `src/cli/` | The CLI's own half — `src/cli/run.ts` is the command table the dispatcher and `help` both read, `src/cli/commands/` one file per group of commands, `src/cli/args.ts` the parsing. |
| `frontend/` | React over `@excalidraw/excalidraw`, built by Vite. `frontend/src/App.tsx` is the canvas and everything hung off `customData`; `frontend/src/components/` holds the panels, the tabs and the terminal. It never touches disk: everything it knows it asked a route for. |
| `scripts/` | The checks. One `scripts/check-*.mjs` per behaviour, each starting whatever it needs and cleaning up after itself, and `scripts/run-checks.mjs` is what `npm test` runs over them. |
| `skills/` | `skills/vibemaxxing-canvas/` — the agent skill this tool installs into a project, so an agent that has never seen the CLI can drive the canvas from `SKILL.md` alone. |
| `docs/` | This directory. Prose, plus `docs/board.excalidraw` — the board is data in the repository, and its cards are what the documentation panel serves. |
| `launchers/` | One double-click file per platform, for a reader who is not going to open a terminal. |

## One press, end to end

A block on the canvas carrying `customData.kind = "issue"` that already has a GitHub issue.
Somebody presses it and then presses **Implement / Fix**. What happens, in order:

1. **The canvas notices the selection.** `frontend/src/App.tsx` hands the scene and the
   selected ids to `resolvePanelTarget` in `src/core/panel-target.ts` — shared with the
   server rather than written twice — and the answer decides which panel opens. For an issue
   block the block's `customData` becomes the panel's state, and
   `frontend/src/components/DocsPanel.tsx` draws the buttons that state allows.

2. **The button becomes a request.** `implementIssueFromBlock` posts to
   `POST /api/implement`, addressed by issue URL rather than by element id: a card mirrored
   from GitHub has no element on the server, and the issue is what is being implemented
   either way. Every request the browser sends carries `?workspace=` naming the board it was
   sent from.

3. **The route refuses, or admits.** Two gates run in front of every route in `src/server.ts`
   before any of them: the origin gate (`src/core/origin-gate.ts`), and the board's token,
   which the page took out of its own address bar on load and now sends as a header
   ([SECURITY.md](SECURITY.md)) — without it the answer is `401` and nothing below happens.
   Two routes are outside both gates and only two: `POST /api/pair/request` and
   `GET /api/pair/status`, where a device with no credential asks for one
   (`src/core/pairing.ts`, approved into `src/core/device-registry.ts`).
   Then both entrances to a run pass `implementingRefused`: an agent command has to be
   configured, and the server has to be bound to loopback. Off loopback this answers `403` —
   an agent that writes to a repository is not something a machine on the network gets to
   start.

4. **The board is resolved to a project.** `workspaceIdFrom` in `src/core/element-store.ts`
   turns `?workspace=` into a workspace id; `loadWorkspaces` in `src/core/workspaces.ts`
   reads the registry and finds the registered project behind it — its path, its agent
   settings, its own workflow file. A board with no project registered has nothing to work
   in, and the request is refused with that sentence.

5. **The slot is claimed.** `beginImplement` refuses a run for an issue that already has one
   in flight, refuses one past the concurrency cap, and then writes the `running` record
   through `src/core/implement-state.ts` before its first `await`. That ordering is the
   guard: counting and claiming have to be one uninterrupted step, or two clicks arriving
   together both count before either claims. The response is `202` and the request is over —
   implementing has no time limit, so a held-open request would only look like a hang.

6. **A checkout is cut for it.** `runImplementation` sends the issue's card to the In Progress
   column through `src/core/project-board.ts`, then calls `ensureWorktree` in
   `src/core/implement-worktree.ts`: `git worktree add`, on a branch named after the issue, in
   a directory *beside* the project rather than inside it, with the dependencies linked in.
   One repository, one object store, several checkouts — which is what lets four runs work at
   once without commits landing on each other's branch.

7. **The agent is spawned.** `runImplementAgent` in `src/core/implement-agent.ts` assembles
   the prompt — what the board tells every agent, then the worktree paragraph, then the
   project's own workflow file last — and hands it to `runAgent` in
   `src/core/issue-agent.ts`. The argv is built by the *backend* the board named —
   `src/core/agent-adapter.ts` and `src/core/agents/`, where `raw` is the passthrough that
   spawns an operator's command line byte for byte, and is what every board gets today.
   `runAgent` spawns exactly that, gives the child the environment `agentEnv` resolves, and
   runs it with the worktree as its working directory. If the board has a terminal tab to spare the run is given one, and a
   reader watches it; with none it happens in a private child, exactly as it did before the
   two features knew about each other.

8. **What the agent printed is checked, not believed.** The pull request URL is read out of
   the output, `src/core/github-pull.ts` asks GitHub what became of it, and
   `src/core/implement-landing.ts` turns the pair into the run's real state. A run that ended
   without landing anything is given one more attempt to finish.

9. **The record goes back to the canvas.** `recordImplement` writes the state onto every
   element carrying that issue and broadcasts an update over the WebSocket, so the block
   redraws itself in every window that has the board open. `releaseWorktree` removes the
   checkout — unless there is uncommitted work in it, in which case it is the only copy of
   that work and it stays.

The same nine steps run with nobody pressing anything when a workspace's queue is on:
`src/core/implement-queue.ts` is the switch, and the queue enters at step 5 through the same
function, because a second entrance that skipped those guards would be a second way for one
issue to become two pull requests.

## What this page is not

It is a map, not a reference. The three entrances are catalogued in
[mcp-server.md](mcp-server.md), [cli.md](cli.md) and [rest-api.md](rest-api.md); the blocks on
the canvas each have their own document, [issue-block.md](issue-block.md) being the one the
walk above passes through; [running.md](running.md) is how to start any of it.

It is also a claim nothing derives. The counts beside the entrances on the board are checked
against `src/` by `scripts/check-docs-counts.mjs`, and the cards are checked against the
documents by `scripts/check-board-map.mjs` — but that a press still reaches the agent by this
route is held only by whoever reads it next. If you find it describing a shape the code no
longer has, that is worth an issue rather than a patch in passing.
