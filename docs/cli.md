# CLI

`src/bin.ts`, published as `@vitorengers/vibemaxxing` and installed as `vibemaxxing`, with
`vibemax` beside it as a shorter alias. 22 commands. It is
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

## Conventions

JSON results on stdout — except `describe`, which is plain text by design, and raw content when
`--out` is omitted (`export` prints the scene JSON, `screenshot --format svg` prints SVG).
Diagnostics go to stderr. Exit codes: `0` ok, `1` error, `2` usage, `3` canvas unreachable,
`4` a browser tab is required. The canvas URL comes from `EXPRESS_SERVER_URL` or `--url`, and
which project board is drawn on from `--workspace` — see below.

Labels and arrow bindings take the agent-friendly spelling everywhere: `"text"` on any shape,
`"startElementId"` and `"endElementId"` on arrows. Normalisation is automatic.

## The commands

| Command | What it does |
|---|---|
| *(no arguments)* / `launch` | Start the board, open it in a browser, print one line |
| `start` / `stop` / `status` | Manage the canvas server; `stop` identity-checks the live server via `/health` before signalling |
| `mcp` | Run the MCP stdio server by name |
| `doctor` | Ask the board whether each agent can actually run — see below |
| `add` | Batch-create elements from a JSON array, given as a file or on stdin; `--one` for a single element |
| `apply` | One-call multi-op patch: `{"create":[...],"update":[{"id":"a","set":{...}}],"delete":["id"]}` |
| `get` / `delete` | Read and remove elements by id |
| `update` | Change one element: `--set` takes the JSON to merge into it |
| `query` | `--type`, `--bbox x0,y0,x1,y1`, `--filter k=v` (typed, nested keys), `--filter-json` |
| `describe` | An agent-readable scene summary, as plain text |
| `screenshot` | `--out`, `--format` (png or svg), `--no-background` — needs a browser tab |
| `export` / `import` | Scene file I/O; a `.md` out path writes Obsidian's `.excalidraw.md` format and `import` reads it back |
| `mermaid` | Mermaid to canvas, from a file or stdin — needs a browser tab |
| `snapshot` | Named snapshots, in memory: `save`, `list`, `restore` |
| `arrange` | Layout operations: `align`, `distribute`, `group`, `ungroup`, `lock`, `unlock`, `duplicate` |
| `share` | Encrypted upload, returning a shareable excalidraw.com URL |
| `clear` | Wipe the canvas — `--yes` to mean it |
| `install-skill` | Install the portable agent skill, into `--dir <skills-root>` |

`apply` is the one worth knowing: it takes a single `{create, update, delete}` patch and
applies it in one call, so a whole edit round-trips once instead of once per element.

## `doctor` — can the agents actually run?

The agents fail the most quietly of anything this tool has: the blocks draw, the buttons are
there, and pressing one does nothing. `doctor` is the way to ask before pressing. It reads the
board's `/health` and reports, per role and per environment, one of `found`, `not found`,
`unconfigured`, `unsupported`, `not probed` or `unknown` — naming the variable to set when the
answer is `not found`.

```
$ vibemaxxing doctor
issue in the native environment [claude]: found version 2.0.14.
implement in the native environment: not found. Set EXCALIDRAW_IMPLEMENT_AGENT to a command
that environment can run.
```

JSON on stdout as usual, prose on stderr. It exits 0 whenever the board answered, including
when what it answered is that an agent is missing — that is a report, and a script that wants
the verdict has the JSON.

What it never prints is the command line, a path or a flag, and neither does `/health`: those
are somebody's absolute paths with their permission flags in them, and `/health` is
unauthenticated on loopback. `backend` is a name out of a list `src/core/agent-preflight.ts`
holds, and `version` is a version number extracted from the output rather than the output. The
same preflight runs at startup and warns there — see [running.md](running.md).

The known limit is that a command is still an opaque string: the probe runs argv[0] with
`--version`, so `node ./my-agent.mjs` reports on `node`. Reading a command as a *backend* is
what an adapter is for.

## It starts the canvas for you

Any command that needs the canvas will start it if nothing is listening — there is no separate
setup step. `start` runs it detached and records a pidfile (`src/core/pidfile.ts`) so `stop`
knows what to kill.

## Which project board a command draws on

`--workspace <id>` names one, on any command, and `--workspace=<id>` is the same thing:

```bash
vibemax add --workspace board-tool elements.json
vibemax describe --workspace board-tool
```

It is global rather than per-command — the same question for all of them — so it is stripped
from the arguments before the command parses them, exactly as `--url` is.
`EXCALIDRAW_WORKSPACE` is the same answer for a whole session, and the flag beats it.

Name none and a board with one registered project uses it, a board with none uses the `default`
scratch canvas, and a board with **several refuses the command and lists the ids** — exit code
`2`, because it is the caller having said too little rather than the canvas failing. An id
nobody registered is refused the same way. [workspaces.md](workspaces.md) is where that rule and
its reasoning live.

Until #344 no command sent `?workspace=` at all, so the CLI always acted on `default` and
driving a registered project board from it was not possible.
