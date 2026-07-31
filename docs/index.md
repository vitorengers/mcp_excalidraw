# Documentation index

Every tracked document in this directory, and what it is for.

This page exists because there was no way into `docs/` by reading. Fifteen of the twenty-two
documents were linked from nothing at all, and the only route to most of them was to open
`board.excalidraw` and click the card that carries their `docKey` — which works for whoever has
the board running and for nobody arriving through a clone. The board is still the map;
`scripts/check-docs-index.mjs` makes sure this list stays a second one.

The board itself is cut into two halves, each with a key that scrolls onto it — `Alt+P` for
**Project structure**, `Alt+G` for **Development**. See [board-sections.md](board-sections.md).

## Start here

| Document | What it covers |
|---|---|
| [running.md](running.md) | How to start the board: the build, the port, and what every `EXCALIDRAW_*` variable means |
| [launchers.md](launchers.md) | The three double-click launchers, and why not a SEA, an Electron shell or a signed app |
| [configuration.md](configuration.md) | Where those values are read from: `config.json` in the state directory, a `<cwd>/.env`, the environment |
| [workspaces.md](workspaces.md) | One project per board — the registry, `board.config.json`, and the settings dialog |
| [board-sections.md](board-sections.md) | The two halves of the board and the keys that reach them |
| [whats-next.md](whats-next.md) | What has not shipped |
| [development-log.md](development-log.md) | One dated entry per merged pull request: the issue, the pull request, and what was decided |

## The three ways in

| Document | What it covers |
|---|---|
| [mcp-server.md](mcp-server.md) | `src/index.ts` over stdio — the tools an agent calls directly |
| [cli.md](cli.md) | `src/bin.ts` — the commands the bundled agent skill actually uses |
| [rest-api.md](rest-api.md) | `src/server.ts` — every route, and the only workspace-aware surface |

## How the canvas holds together

| Document | What it covers |
|---|---|
| [element-store.md](element-store.md) | One `Map` per workspace, in memory, created on first use |
| [sync-reconciliation.md](sync-reconciliation.md) | How a browser's edits and a run's writes merge without either losing |
| [canvas-frontend.md](canvas-frontend.md) | The React frontend, one tab per project |
| [claude-status.md](claude-status.md) | The Claude Code usage HUD in the header — the 5h and 7d windows, per environment |

## The blocks on the canvas

A shape's `customData` decides what it is: a `docKey` makes it a documentation card, and a
`kind` makes it one of the four functional blocks.

| Document | What it covers |
|---|---|
| [docs-block.md](docs-block.md) | `customData.docKey` — the card that opens a markdown panel |
| [collapsible-image.md](collapsible-image.md) | `customData.collapsed` — an image that folds down and back to the geometry it had |
| [issue-block.md](issue-block.md) | `customData.kind = "issue"` — an observation that becomes a GitHub issue, and then an implementation |
| [project-board.md](project-board.md) | `customData.kind = "project-board"` — the GitHub project mirrored on the canvas, and the implementation queue |
| [terminal.md](terminal.md) | `customData.kind = "terminal"` — real shells, as tabs, on the board |
| [shared-library.md](shared-library.md) | The `.excalidrawlib` shapes every board gets |

`customData.kind = "board-section"` is the fourth kind; it is a mark rather than a block, and
[board-sections.md](board-sections.md) covers it.

## Traps already paid for

Each of these cost a day or more once. They are here so the second time is free.

| Document | The trap |
|---|---|
| [trap-port-3000.md](trap-port-3000.md) | A portproxy rule maps port 3000 to itself; the server looks healthy and every request hangs |
| [trap-stale-server.md](trap-stale-server.md) | The old server does not die, and keeps answering with the old code |
| [trap-allowed-tools.md](trap-allowed-tools.md) | A `-p` agent without `--allowedTools` investigates, is refused, and exits 0 |
| [trap-gh-path.md](trap-gh-path.md) | A server started before the CLI was installed hands that stale `PATH` to the agent |
| [trap-agent-timeout.md](trap-agent-timeout.md) | The agent outlives its own issue, so the timeout salvages the URL rather than calling the work a failure |
| [trap-export-noise.md](trap-export-noise.md) | Volatile metadata changes on every export and makes the diff say nothing |
| [trap-check-environment.md](trap-check-environment.md) | An untracked `.env` restores what a check deleted, and a port derived from the process id collides |
