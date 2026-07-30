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

It also returns **`workspaces`** — `configured` or `none` — **`terminal`**, and **`agents`**
(`{ issue, implement }`, two booleans because the two variables are separate ones), and those
are what tell you the board is a board. Read `agents` first after a restart: they fail the most
quietly of the three, because the blocks still draw and the buttons are still there and pressing
one simply does nothing. Anything that runs a canvas-driving CLI command can
auto-start a server (`EXCALIDRAW_NO_AUTOSTART=1` stops it), and an auto-started one inherits the
environment of whatever started it — which for an MCP server attached to an editor is no
`EXCALIDRAW_*` at all. It binds this port, answers `status: healthy` and is not your board: no
project tabs, no terminal, no agents, empty canvas. `workspaces: "none"` on a port you started a
configured board on means something replaced it; kill it and start yours again.

## Restarting it from the board

`Restart Server`, at the right-hand end of the bar. It is the answer to the trap above rather
than another way into it: the route hands the job to a process outside the server's own tree,
which carries the board's environment across and refuses to call the restart done until the new
`/health` reports a **different pid** with the same registry, terminal and agents. See
[rest-api.md](rest-api.md#post-apirestart).

What does not survive it:

- **Terminal sessions.** Every shell on every board closes, with whatever was running in it.
- **Implementation state**, which is in memory. Runs that were live are recorded as
  `interrupted` and re-derived from git the next time the board looks.

What does: **the boards themselves**, saved beside the registry. And the open page, which
reconnects on its own — it shows Disconnected on the way, and nothing needs reloading.

It starts the build that is on disk. **After `npm run build`, a restart is what picks it up**;
a restart is not itself a build.

Offered only on loopback — the route answers 403 anywhere else, and the button is disabled when
the page was not reached over loopback. If the restart fails, the account of it is in
`restart-<port>.log` in the same directory as the pidfile (`%LOCALAPPDATA%\Excalidraw-Canvas` on
Windows): the process that asked for the restart is gone by the time the answer exists, so
nothing else is watching.

**Do not restart the board from a terminal block.** That is the failure this replaced, and it is
still a failure: the block is a child of the server, so the kill kills the shell running it and
the port goes to whatever auto-starts first.

## The environment

`PORT` and `HOST` decide where it listens. **`PORT=3737`** on the development machine — 3000 is
unusable there. The checks never use either: each starts its own instance on a port the kernel
just handed out, and neither `PORT` nor anything else in the environment reaches it.

Everything else is `EXCALIDRAW_*`, and every one of them is optional. Unset means the feature is
off, not degraded.

The nineteen below mean the same thing on Windows, macOS and Linux. Three more are Windows-only,
and they are in [their own section](#windows-only-projects-inside-a-wsl-distro) rather than here.

| Variable | Default | What it does |
|---|---|---|
| `EXCALIDRAW_WORKSPACES` | unset | Path to the registry JSON. Unset means one `default` board and no project tabs — see [workspaces.md](workspaces.md) |
| `EXCALIDRAW_BOARD_STATE` | beside the registry | Where each registered board is saved between processes. Unset puts them in a directory named after the registry file; with no registry, nothing is saved — [element-store.md](element-store.md) |
| `EXCALIDRAW_DOCS_DIR` | unset | Where `GET /api/docs/:key` reads *this tool's own* documentation from. Unset disables it: serving arbitrary files from an unauthenticated local API is not a default |
| `EXCALIDRAW_LIBRARY` | unset | An `.excalidrawlib` served to every board, alongside each project's own — [shared-library.md](shared-library.md) |
| `EXCALIDRAW_ISSUE_AGENT` | unset | The command line that researches an observation and opens the issue. Unset means issue blocks do nothing |
| `EXCALIDRAW_IMPLEMENT_AGENT` | unset | The command line that implements one. Unset means the button is not offered |
| `EXCALIDRAW_ISSUE_AGENT_TIMEOUT` | none | Seconds. Unset means no ceiling; a wedged run is handled by the block's reset instead |
| `EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT` | none | The same, for implementing |
| `EXCALIDRAW_IMPLEMENT_CONCURRENCY` | `4` | Runs at once. `0` is no cap, `1` serialises. Each one is a whole coding agent building on this machine |
| `EXCALIDRAW_IMPLEMENT_QUEUE_MS` | `30000` | How often a workspace with its queue on looks for a free slot. The timer does not exist until a queue is turned on |
| `EXCALIDRAW_ISSUE_MEMO_MS` | `30000` | How long one `gh` read of an issue is reused. `0` turns the memo off |
| `EXCALIDRAW_GH_COMMAND` | `gh` | The GitHub CLI on **this machine**, when it is not on `PATH` — [trap-gh-path.md](trap-gh-path.md) |
| `EXCALIDRAW_CLAUDE_STATUS` | unset | The directory your Claude Code status line command writes its usage files into. Unset means `GET /api/claude-status` answers 404 and the header shows nothing — [claude-status.md](claude-status.md) |
| `EXCALIDRAW_TERMINAL` | unset | `1` for the default shell, or a command line of your own. Unset means the terminal routes answer 404 — [terminal.md](terminal.md) |
| `EXCALIDRAW_TERMINAL_PTY` | unset | `0` forces the pipe instead of a real pty, for a machine with no prebuilt binary |
| `EXCALIDRAW_EXPORT_DIR` | working dir | The base directory MCP file exports may write to |
| `EXCALIDRAW_NO_AUTOSTART` | unset | `1` stops the CLI and the MCP server auto-spawning a canvas |
| `EXCALIDRAW_NO_DOTENV` | unset | `1` stops the server reading `<cwd>/.env` at all. The checks set it, because dotenv only ever fills in variables that are *unset* — which is exactly the set a check deleted on purpose — [trap-check-environment.md](trap-check-environment.md) |
| `EXCALIDRAW_ENV_FILE` | `<cwd>/.env` | Read this file instead. Ignored when `EXCALIDRAW_NO_DOTENV=1` |

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

## Windows only: projects inside a WSL distro

**Everything in this section is Windows-only, and the board says so on macOS and Linux rather
than trying.** A project registered with a `distro` runs through `wsl.exe`, which is a Windows
binary: the agent command, the worktree's `git` and the `gh` the project board mirror polls with
are all built as `wsl.exe -d <distro> …`. Off Windows there is no such program, so the board
refuses instead of spawning one — the tab comes up broken reading `WSL-backed projects are
Windows-only; this board is running on darwin`, and `POST /api/workspaces` answers 400 to a
`distro` with the same sentence. If a remote or container backend is ever wanted there, it is a
new workspace kind with a command builder of its own, not this one renamed: they would share the
shape and neither the path translation nor the `--exec bash -lc` quoting.
`node scripts/check-wsl-windows-only.mjs` holds this.

| Variable | Default | What it does |
|---|---|---|
| `EXCALIDRAW_ISSUE_AGENT_WSL` | unset | The issue command, spelled as a **WSL-backed** project's distro spells it. Unset falls back to `EXCALIDRAW_ISSUE_AGENT`, which only resolves inside a distro if it was written without an absolute path |
| `EXCALIDRAW_IMPLEMENT_AGENT_WSL` | unset | The same, for implementing. A pair rather than one variable for the reason `EXCALIDRAW_ISSUE_AGENT` and `EXCALIDRAW_IMPLEMENT_AGENT` are a pair: granting a distro research must not thereby grant it repository writes |
| `EXCALIDRAW_GH_COMMAND_WSL` | `gh` | The GitHub CLI inside a **WSL-backed** project's distro. Unlike the agents' `_WSL` pair this does **not** fall back to the host value: a host path is exactly what cannot run there |

**A project inside a WSL distro needs the `_WSL` command.** Its agent runs inside the distro, so
the command is resolved there: a host path like `C:/Users/you/.local/bin/claude.exe` is
`No such file or directory` inside a distro, and the run exits 127 before it does anything. Set
`EXCALIDRAW_ISSUE_AGENT_WSL` — and `EXCALIDRAW_IMPLEMENT_AGENT_WSL`, separately — to the command
as the distro names it:

```
/home/you/.local/bin/claude -p --model claude-opus-5[1m] --effort high --allowedTools "..."
```

That the command is granted by the environment rather than by the project is the same rule the
section above states — a `board.config.json` retunes an agent and never supplies one — and the
reason a WSL project cannot simply declare its own.

**And `gh` is resolved per project for the same reason** — `EXCALIDRAW_GH_COMMAND` is the host's
CLI and nothing else. Where the distro has `gh` on its own `PATH`, which is the usual case,
there is nothing to set: a WSL project falls back to the bare `gh` rather than to the host path,
because a host path there can only produce `command not found`. Set
`EXCALIDRAW_GH_COMMAND_WSL` where it does not. See
[trap-gh-path.md](trap-gh-path.md#it-is-two-machines-and-two-binaries).

## What a running board looks like

- Tabs along the top, one per registered project, with `+` to add another and a gear for that
  project's settings.
- `Alt+P` and `Alt+G` jump to the two halves of this repository's own board — see
  [board-sections.md](board-sections.md).
- `Alt+B` scrolls to the GitHub project mirror, `Alt+T` to the terminal.
- Each project that names a `board` in its `board.config.json` comes up holding it: the file is
  read into that board's store just after the port opens ([element-store.md](element-store.md)).
- Every registered board is saved a second after it last changed, beside the registry that lists it
  — `board-workspaces.json` keeps them in a `board-workspaces-state` directory, or wherever
  `EXCALIDRAW_BOARD_STATE` says. That is what comes back at the next start, unless the project's
  `board` file has been written since. Nothing is written into any project.
- Into the *tracked* board file, nothing is saved back: `scripts/export-board.mjs` is how
  `docs/board.excalidraw` is written, and it is a commit like any other. Both flags are
  required — the script has no default board:

  ```
  node scripts/export-board.mjs --url http://127.0.0.1:3737 --workspace board-tool \
                                --out docs/board.excalidraw
  ```

  `--url` is the port *this* board was started on (`PORT`, 3737 here — not one of the
  throwaway instances a check starts, which are gone by the time you could point at them),
  and `--workspace` is the board being exported.
  Run with either flag missing it exits 2 and writes nothing, because a request that guesses
  its own source is one absent flag away from committing whatever else was listening.

## Verifying a change

```
./node_modules/.bin/tsc          # the server
./node_modules/.bin/vite build   # the frontend
node scripts/check-<name>.mjs
node scripts/check-board-map.mjs
```

Compiling is not working. Anything that changes what the browser does has to be looked at in a
browser — three defects in the UI layer compiled cleanly and did none of what they claimed.

## Which checks run where

Not every check can run on every machine, and a check that quietly skips itself is
indistinguishable from one that passed. So each `scripts/check-*.mjs` declares one tier in its
banner — `Tier: fast` — and `scripts/run-checks.mjs` selects on it:

```
node scripts/run-checks.mjs --tier fast,browser   # the contributor gate
node scripts/run-checks.mjs --list                # what would run, and nothing else
```

| Tier | Needs, beyond Node and a built `dist/` | Runs on | Checks | On the contributor gate |
|---|---|---|---|---|
| `fast` | nothing | Linux, macOS, Windows | 90 | yes |
| `browser` | a Chrome or an Edge to drive | Linux, macOS, Windows | 67 | yes |
| `windows` | win32 — the check gives up on anything else | Windows | 1 | no |
| `wsl` | a real distro behind `wsl.exe` | Windows with WSL | 5 | no — the maintainer runs these |
| `repo` | the full history, and this repository's own board | anywhere with a full clone | 5 | no |

The gate is `fast` plus `browser`. `repo` is off it because it cannot be satisfied from a
contributor's fork — `check-board-map.mjs` reads `docs/board.excalidraw` and the merge history
of *this* fork — and `wsl` is off it because a hosted runner has no distro.

A tier whose tool is not on the machine is reported as **EXPECTED-SKIP** and the run still
exits 0, so `--tier wsl` on a Linux box is honest rather than green. `browser` is the one
exception: with no Chrome it *fails*, because a runner that was meant to have one and does not
would otherwise hide sixty-seven checks behind a green tick that never ran them.

The tiers are held to the source by `node scripts/check-tiers.mjs`: a check added with no
`Tier:` line fails it, as does one that spawns `wsl.exe` while calling itself `fast`.

### And a green run says how much of itself it ran

The tier gate above answers whether this *machine* has a browser. It does not answer whether
each check in the tier found one: a check handed a `CHROME_PATH` that points at nothing, or a
`--chrome` at a stale path, used to print `SKIPPED` and exit 0 — the same exit code as a pass,
so a runner reading it counted a check that measured nothing as a check that ran.

So a check that cannot find a browser exits **3** rather than 0, under `CHECK_STRICT=1` or
`--strict`, and says which paths it looked at:

```
CHECK_STRICT=1 node scripts/check-board-landing-browser.mjs
```

Without either, the behaviour is unchanged — `SKIPPED` and exit 0 — because an operator running
one check by hand on a machine with no browser wants a skip, not a failure. The exit code rather
than a marker on stdout is deliberate: a runner has to classify a check that died before it
printed anything.

`run-checks.mjs` spawns every child with `CHECK_STRICT=1` whatever it was itself given — that is
what makes a skip visible at all — and then decides what to do with it. It reads exit 3 as SKIP,
and as FAIL under `--strict`:

```
node scripts/run-checks.mjs --tier browser            # … — 0 skipped for want of a browser
node scripts/run-checks.mjs --tier browser --strict   # any that gave up now fail the run
```

The count is printed on **every** run, passing or not. That is the whole point of it: a green
run has to say out loud how much of itself it did not execute.

**`CHROME_PATH` is authoritative**, the same way `--chrome` is: naming a browser that is not
there is an error, not a reason to fall back to one somewhere else. That is what makes
`CHROME_PATH=/nonexistent` a way to exercise the skip path on a machine that does have Chrome.

`scripts/lib/find-chrome.mjs` holds the one candidate list — Windows Chrome and Edge, the macOS
bundle, `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser` and, last,
`/snap/bin/chromium`. It is last because a snap-confined Chromium launches under a different
sandbox posture and CDP may not attach the same way, so it is only ever reached where no
ordinary install exists to win. Adding a path anywhere else is a second copy that will drift,
and `node scripts/check-browser-strict.mjs` fails on one.
