# CLI

`src/bin.ts`, published as `mcp-excalidraw-server` and `excalidraw-canvas`. 19 commands. It is
the interface the bundled agent skill actually uses, because a shell command is cheaper for an
agent to reach for than a tool definition it has to be handed first.

## The commands

| Group | Commands |
|---|---|
| Server | `start` `stop` `status` |
| Elements | `add` `update` `delete` `get` `query` `apply` |
| Scene | `describe` `screenshot` `export` `import` `mermaid` `share` `clear` |
| Other | `snapshot` `arrange` `install-skill` |

`apply` is the one worth knowing: it takes a single `{create, update, delete}` patch and
applies it in one call, so a whole edit round-trips once instead of once per element.

## It starts the canvas for you

Any command that needs the canvas will start it if nothing is listening — there is no separate
setup step. `start` runs it detached and records a pidfile (`src/core/pidfile.ts`) so `stop`
knows what to kill.

## Limitation

Like the MCP tools, no command sends `?workspace=`, so the CLI always acts on the `default`
store. Driving a registered project board from the CLI is not possible today; that needs a
`--workspace` flag threaded through `src/core/canvas-client.ts`.
