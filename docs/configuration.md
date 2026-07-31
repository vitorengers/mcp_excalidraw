# Where the configuration comes from

Three sources, layered, lowest first. [running.md](running.md) is what each variable *means*;
this is where the values are read from and which one wins.

| | Source | Read by |
|---|---|---|
| 1 | `<state-dir>/config.json` | every process — the board, the CLI, the MCP server |
| 2 | `<cwd>/.env` | the same, from **its own** working directory |
| 3 | the real environment | the same, and it beats both files |

`src/core/settings.ts` is all of it; `src/core/env.ts` is the one-line module the entry points
import so that the layers are applied before anything reads a variable — including
`src/core/port.ts`, which resolves the canvas port out of the environment the layers produced.

## Why there is a file at all

Until #304 the only source was layer 2, and `.env` is gitignored, had no tracked example, and
sits wherever the caller's shell happened to be. That last part is the defect: a double-clicked
launcher has an unpredictable working directory — `C:\Windows\System32` from a shortcut, `/`
from a `.desktop` entry, the home directory from Finder — so it can never find a `.env`, and the
board comes up with no workspaces, no terminal and no agents while answering `status: healthy`
on the port the real board was meant to hold.

The state directory is chosen from the platform instead of from the caller, so it is the same
directory whichever way the tool was started:

| Platform | Directory |
|---|---|
| Windows | `%LOCALAPPDATA%\Excalidraw-Canvas` |
| macOS | `~/Library/Application Support/excalidraw-canvas` |
| Linux and other POSIX | `$XDG_STATE_HOME/excalidraw-canvas`, or `~/.local/state/excalidraw-canvas` |

The pidfile, the restart log, the startup log and the running board's `canvas.json` were already
there; the configuration joins them. A reader tries the `VibeMaxxing-Canvas` spelling first and
falls back to the one above, which is the rename-survival order `src/core/identity.ts` explains.

`EXCALIDRAW_STATE_HOME` redirects the *parent* of that directory, and it is read from the
environment only — a file cannot name the directory it is in.

## The file

A flat JSON object of the same names the environment uses. Numbers and booleans are written as
themselves and read as the strings an environment holds. [config.example.json](../config.example.json)
is the tracked copy:

```json
{
  "EXCALIDRAW_CANVAS_PORT": 3737,
  "HOST": "127.0.0.1",
  "EXCALIDRAW_WORKSPACES": "C:/Users/you/board-workspaces.json",
  "EXCALIDRAW_TERMINAL": "1",
  "EXCALIDRAW_GH_COMMAND": "gh"
}
```

There is no allowlist. Every key is read, because which of the variables in
[running.md](running.md) survive into a near-zero-config release is a separate question, and a
list kept in the reader would answer it by accident — silently dropping whatever it had not been
told about.

A file that is not there says nothing, which is the ordinary case. A file that is malformed says
so on stderr and is then ignored: refusing to start because a configuration file has a stray
comma would make the launch path more fragile than the `.env` it replaces, not less.

**`vibemaxxing start` writes one on first launch**, holding the resolved port and nothing else.
Not because the port needs writing down — it is already the default — but because a file that
exists is a file somebody can open and add a registry to. It is never overwritten afterwards.

**The port it writes is `EXCALIDRAW_CANVAS_PORT`, not `PORT`.** They are the same number with
different promises attached: since #303 a `PORT` that is set is a **pin** the launch path never
scans past, and `EXCALIDRAW_CANVAS_PORT` is the port to *try first*. Writing the pin would
quietly convert every later launch on the machine into one that fails when something else holds
that port, instead of walking to the next free one.

## The working directory a board gets

`src/core/spawn.ts` starts the canvas server with the state directory as its **explicit** `cwd`.
It used to pass none, so the board inherited the caller's — which is why
[running.md](running.md#the-environment) has to warn that an MCP server attached to an editor
auto-starts a canvas in that editor's project, holding the board's port with none of the board's
environment.

So for a *launched* board, layer 2 is the `.env` beside `config.json`. For a CLI or MCP process,
and for a server started by hand with `node dist/server.js`, it is still the one beside the
shell — nothing about running the server directly has changed.

The environment handed to that child is the one the CLI was **started** with, not the one it
read its own files into. Passing the latter is what let the launch directory decide what the
board is: a `.env` in whatever directory somebody typed the command in arrived in the board as
though it had been exported. `PORT` and `HOST` are the deliberate exception — the caller has
already resolved where this board goes, and the child must not resolve it a second time and
differently.

## Turning the files off

`EXCALIDRAW_NO_DOTENV=1` turns off **both** file layers, leaving only the real environment.
Every check sets it (`scripts/lib/spawn-canvas.mjs`), and it exists because of what layering
*under* the environment means in reverse: the only values a file can supply are exactly the ones
a caller deliberately removed. `check-workspace-settings.mjs` builds a server with no implement
agent to prove `/api/implement` answers 404, and on a machine with an `.env` it got the
operator's real coding agent back and started one — see
[trap-check-environment.md](trap-check-environment.md).

`EXCALIDRAW_ENV_FILE` names a file instead of `<cwd>/.env`. It has no effect under
`EXCALIDRAW_NO_DOTENV=1`, and it does not move `config.json`; `EXCALIDRAW_STATE_HOME` does that.

`scripts/check-launch-cwd-independent.mjs` holds all of this: it launches a board from a
directory holding a decoy `.env` and asserts the board is the state file's.
