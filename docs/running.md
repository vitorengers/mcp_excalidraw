# Running the board

How to start Board Tool. Until #151 this was written down nowhere in the repository: four
tracked documents cited a PowerShell start script that has never been in `git ls-files`, and the
only start instruction a clone actually got was the upstream README's port 3000 — which
[trap-port-3000.md](trap-port-3000.md) explains can never work on the machine this fork is
developed on.

It is a **procedure, not a script.** Every value below that has to be a path on one particular
machine — the registry, the agent binaries, the port — is the operator's, and a tracked script
would either hardcode one person's paths or be a wrapper around this list of environment
variables. Write the procedure down once; keep the values wherever you keep secrets and paths.

## The short version

```bash
npm ci
npm run build            # vite build, then tsc — the server serves the built frontend
node dist/server.js      # with the environment below
```

Then open `http://127.0.0.1:<PORT>`. A tab has to be open for anything that renders: screenshots,
PNG/SVG export, viewport control and Mermaid conversion all happen in the frontend.

## Before you start: kill what is already listening

This is the trap that costs the most, because everything looks like it worked — see
[trap-stale-server.md](trap-stale-server.md). A second server fails to bind and exits; the first
one keeps answering, silently, with the old code.

```powershell
$busy = Get-NetTCPConnection -LocalPort $env:PORT -State Listen -ErrorAction SilentlyContinue
foreach ($processId in ($busy.OwningProcess | Select-Object -Unique)) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
```

`$processId`, never `$pid`: `$PID` is a read-only automatic variable and the loop throws on it.

`GET /health` returns the `pid` of whatever is answering. When a change seems to have had no
effect, compare that against the process you believe you started.

## The environment

`PORT` and `HOST` decide where it listens. **`PORT=3737`** on the development machine — 3000 is
unusable there. The throwaway instances the self-contained checks start choose their own free
port; the older `--url` family of checks expects one started by hand on **3838**, which is
deliberately a different, empty server rather than the board you are working on.

Everything else is `EXCALIDRAW_*`, and all seventeen are optional. Unset means the feature is off,
not degraded.

| Variable | Default | What it does |
|---|---|---|
| `EXCALIDRAW_WORKSPACES` | unset | Path to the registry JSON. Unset means one `default` board and no project tabs — see [workspaces.md](workspaces.md) |
| `EXCALIDRAW_DOCS_DIR` | unset | Where `GET /api/docs/:key` reads *this tool's own* documentation from. Unset disables it: serving arbitrary files from an unauthenticated local API is not a default |
| `EXCALIDRAW_LIBRARY` | unset | An `.excalidrawlib` served to every board, alongside each project's own — [shared-library.md](shared-library.md) |
| `EXCALIDRAW_ISSUE_AGENT` | unset | The command line that researches an observation and opens the issue. Unset means issue blocks do nothing |
| `EXCALIDRAW_IMPLEMENT_AGENT` | unset | The command line that implements one. Unset means the button is not offered |
| `EXCALIDRAW_ISSUE_AGENT_WSL` | unset | The same command, spelled as a **WSL-backed** project's distro spells it. Unset falls back to `EXCALIDRAW_ISSUE_AGENT`, which only resolves inside a distro if it was written without an absolute path |
| `EXCALIDRAW_IMPLEMENT_AGENT_WSL` | unset | The same, for implementing. A pair rather than one variable for the reason the pair above is a pair: granting a distro research must not thereby grant it repository writes |
| `EXCALIDRAW_ISSUE_AGENT_TIMEOUT` | none | Seconds. Unset means no ceiling; a wedged run is handled by the block's reset instead |
| `EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT` | none | The same, for implementing |
| `EXCALIDRAW_IMPLEMENT_CONCURRENCY` | `4` | Runs at once. `0` is no cap, `1` serialises. Each one is a whole coding agent building on this machine |
| `EXCALIDRAW_IMPLEMENT_QUEUE_MS` | `30000` | How often a workspace with its queue on looks for a free slot. The timer does not exist until a queue is turned on |
| `EXCALIDRAW_ISSUE_MEMO_MS` | `30000` | How long one `gh` read of an issue is reused. `0` turns the memo off |
| `EXCALIDRAW_GH_COMMAND` | `gh` | The GitHub CLI, when it is not on `PATH` — [trap-gh-path.md](trap-gh-path.md) |
| `EXCALIDRAW_TERMINAL` | unset | `1` for the default shell, or a command line of your own. Unset means the terminal routes answer 404 — [terminal.md](terminal.md) |
| `EXCALIDRAW_TERMINAL_PTY` | unset | `0` forces the pipe instead of a real pty, for a machine with no prebuilt binary |
| `EXCALIDRAW_EXPORT_DIR` | working dir | The base directory MCP file exports may write to |
| `EXCALIDRAW_NO_AUTOSTART` | unset | `1` stops the CLI and the MCP server auto-spawning a canvas |

**Pin the agents' model and effort.** Without `--model` and `--effort` on those two command
lines the agent inherits whatever `~/.claude/settings.json` says, so changing the model of an
interactive session silently changes who writes the issues.

**`--allowedTools` is mandatory** for a `-p` agent: without it the run investigates fine, is
refused the moment it needs `gh`, and exits 0 with nothing to show — see
[trap-allowed-tools.md](trap-allowed-tools.md) and the configuration section of
[issue-block.md](issue-block.md#configuration), which is where the full shape of both command
lines lives.

A per-project `board.config.json` can override the model, the effort and the time limit for
either agent. It cannot override the command itself; that boundary and its reasoning are in
[issue-block.md](issue-block.md).

**A project inside a WSL distro needs the `_WSL` command.** Its agent runs inside the distro, so
the command is resolved there: a host path like `C:/Users/you/.local/bin/claude.exe` is
`No such file or directory` inside a distro, and the run exits 127 before it does anything. Set
`EXCALIDRAW_ISSUE_AGENT_WSL` — and `EXCALIDRAW_IMPLEMENT_AGENT_WSL`, separately — to the command
as the distro names it:

```
/home/you/.local/bin/claude -p --model claude-opus-5[1m] --effort high --allowedTools "..."
```

That the command is granted by the environment rather than by the project is the same rule as
above, and the reason a WSL project cannot simply declare its own in `board.config.json`.

## What a running board looks like

- Tabs along the top, one per registered project, with `+` to add another and a gear for that
  project's settings.
- `Alt+P` and `Alt+G` jump to the two halves of this repository's own board — see
  [board-sections.md](board-sections.md).
- `Alt+B` scrolls to the GitHub project mirror, `Alt+T` to the terminal.
- Each project that names a `board` in its `board.config.json` comes up holding it: the file is
  read into that board's store just after the port opens ([element-store.md](element-store.md)).
- Nothing is saved back. The store is in memory and a change dies with the process;
  `scripts/export-board.mjs` is how `docs/board.excalidraw` is written back, and it is a commit
  like any other.

## Verifying a change

```
./node_modules/.bin/tsc          # the server
./node_modules/.bin/vite build   # the frontend
node scripts/check-<name>.mjs
node scripts/check-board-map.mjs
```

Compiling is not working. Anything that changes what the browser does has to be looked at in a
browser — three defects in the UI layer compiled cleanly and did none of what they claimed.
