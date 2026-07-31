# CLI

`src/bin.ts`, published as `@vitorengers/vibemaxxing` and installed as `vibemaxxing`, with
`vibemax` beside it as a shorter alias. 21 commands. It is
the interface the bundled agent skill actually uses, because a shell command is cheaper for an
agent to reach for than a tool definition it has to be handed first.

The names come from one place. `package.json` `bin` declares them, `BIN_NAME` and `BIN_NAMES`
in `src/core/version.ts` read that map, and every command named in help or error text is built
out of those — so a rename lands in the manifest alone and cannot leave help text advertising a
command npm does not install. `scripts/check-bin-identity.mjs` holds it, along with the rule
that the two command names inherited from upstream may not come back: upstream's published
package installs both, so a global install of the two packages fights over the same command.

## Typed with no arguments at all

`vibemaxxing` on its own is the first thing anybody types, and it brings the board up, opens it in
a browser and prints one line:

```
VibeMaxxing 0.1.0 — http://127.0.0.1:3737
```

That is the whole output — the URL goes to stdout, everything else to stderr — and a second
invocation against a board that is already running prints the same line and brings the tab back to
the front, rather than reporting that it did nothing.

**It only launches when there is a person on the other end**, and that is not a nicety. Every MCP
client configuration this project documents is `npx -y @vitorengers/vibemaxxing` with no arguments,
and npx resolves that to a symlink named after the command — so the product's own name arrives on
`argv[1]` in exactly the case where launching would be wrong. What decides is stdin: an MCP client
always hands it a pipe, a person always has a terminal on it. A name this package does not install
is the stdio server whatever is on stdin, so a configuration written before the rename of #297 is
safe too. `src/core/entry-name.ts` holds the rule and `scripts/check-launch-command.mjs` holds it
to the three shapes an installed command really arrives in — a POSIX symlink, a Windows `.cmd`
shim (which erases the name before Node starts, so there the terminal is all there is), and
`node dist/bin.js`.

Neither guess is needed if you say which you want: `launch` is the board, `mcp` is the transport.

## Not opening a browser

`--no-open`, or `VIBEMAXXING_NO_OPEN=1`, launches without touching the browser. A stdout that is
not a terminal suppresses it on its own, so an agent, a CI job or a script reading the URL out of
a pipe is unaffected without having to say anything.

`VIBEMAXXING_OPEN_COMMAND` replaces the platform opener with a command line of your own, the URL
appended as its last argument — for a machine that has no `xdg-open`, which includes minimal Linux
images and WSL without `wslu`. Every failure to open degrades to the printed URL and never to an
error.

## The commands

| Group | Commands |
|---|---|
| Server | `launch` `start` `stop` `status` `mcp` |
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
