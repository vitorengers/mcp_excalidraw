# CLI

`src/bin.ts`, published as `@vitorengers/vibemaxxing` and installed as `vibemaxxing`, with
`vibemax` beside it as a shorter alias. 19 commands. It is
the interface the bundled agent skill actually uses, because a shell command is cheaper for an
agent to reach for than a tool definition it has to be handed first.

The names come from one place. `package.json` `bin` declares them, `BIN_NAME` and `BIN_NAMES`
in `src/core/version.ts` read that map, and every command named in help or error text is built
out of those — so a rename lands in the manifest alone and cannot leave help text advertising a
command npm does not install. `scripts/check-bin-identity.mjs` holds it, along with the rule
that the two command names inherited from upstream may not come back: upstream's published
package installs both, so a global install of the two packages fights over the same command.

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
