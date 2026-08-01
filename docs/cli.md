# CLI

`src/bin.ts`, published as `@vitorengers/vibemaxxing` and installed as `vibemaxxing`, with
`vibemax` beside it as a shorter alias. 23 commands. It is
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
`4` a browser tab is required. The canvas URL comes from `EXPRESS_SERVER_URL` or `--url`.

Labels and arrow bindings take the agent-friendly spelling everywhere: `"text"` on any shape,
`"startElementId"` and `"endElementId"` on arrows. Normalisation is automatic.

## The commands

| Command | What it does |
|---|---|
| *(no arguments)* / `launch` | Start the board, open it in a browser, print one line |
| `start` / `stop` / `status` | Manage the canvas server; `stop` identity-checks the live server via `/health` before signalling, and `status` prints the running version beside the installed one |
| `restart` | Replace the running canvas with this build, on the same port — see below |
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
| `snapshot` | Named snapshots, in memory and per board: `save`, `list`, `restore` |
| `arrange` | Layout operations: `align`, `distribute`, `group`, `ungroup`, `lock`, `unlock`, `duplicate` |
| `share` | Encrypted upload, returning a shareable excalidraw.com URL |
| `clear` | Wipe the canvas — `--yes` to mean it. Prints `backup`: the file the board was copied into first, beside its saved state |
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

## …but not one from another version

An auto-started canvas is detached and unref'd: it outlives the session that started it, and it
goes on holding the port and serving its own `dist/frontend`. So on an update path of
`npx -y @vitorengers/vibemaxxing@latest`, the second use of an upgraded tool meets the first
one's server — and every request succeeds against the code of the release before. That is
[trap-stale-server.md](trap-stale-server.md), "the old one keeps answering, silently, with the
old code".

`GET /health` now carries the package version, and every command that drives the canvas compares
it against its own before attaching. When they differ, the command **refuses** and says so:

```
$ vibemaxxing describe
Error: The canvas server at http://127.0.0.1:3737 is version 0.1.0; this one is 0.2.0. It is
serving that build's code and frontend, so this command would act on software that is not the
one you installed. Replace it with `vibemaxxing restart`, or set
VIBEMAXXING_ALLOW_VERSION_SKEW=1 to use it as it is.
```

Refusing rather than restarting on your behalf, because a restart discards whatever the running
board holds — the scene as the browser has it, its terminal sessions, its coding agents mid-run.
A canvas that reports no version at all is treated the same way and named as such: the field has
been in `/health` since #347, so a server without it is from a build older than the one asking.

`VIBEMAXXING_ALLOW_VERSION_SKEW=1` attaches anyway. It exists for one real arrangement — a
working copy's `dist/` driving a globally installed board — and not as a general escape hatch.

`status` is the exception: it reports instead of refusing, because it is the command you run to
find out.

```
$ vibemaxxing status
{
  "running": true,
  "url": "http://127.0.0.1:3737",
  "pid": 24680,
  "version": "0.1.0",
  "installedVersion": "0.2.0",
  "versionMismatch": true,
  ...
}
```

## `restart` — the same port, a newer build

`restart` stops the running canvas and starts one from *this* install on the port it held.

It is deliberately not `POST /api/restart`. That route hands the work to a supervisor which
starts `dist/server.js` resolved relative to the dying process's own module URL — the *old*
install — which is exactly wrong for the case this command exists for. What the route gets for
free and this cannot is the environment: the supervisor carries the old server's, and the CLI can
only carry the shell's. A board configured through `config.json` in the state directory is
unaffected; one configured by exported variables comes back as whatever the current shell holds.

Stopping the server stops every coding agent it is hosting, so `restart` asks `/health` how many
runs are in flight — across every workspace, not just `default` — and refuses while any are:

```
$ vibemaxxing restart
Error: The canvas server at http://127.0.0.1:3737 is implementing 2 issues right now, and
stopping it would end those runs where they stand. Wait for them, or pass --force to restart
anyway.
```

`scripts/check-canvas-version-skew.mjs` holds all of it, `restart` included.

## Limitation

Like the MCP tools, no command sends `?workspace=`, so the CLI always acts on the `default`
store. Driving a registered project board from the CLI is not possible today; that needs a
`--workspace` flag threaded through `src/core/canvas-client.ts`.
