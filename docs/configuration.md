# Where the configuration comes from

Three sources, layered, lowest first. [running.md](running.md) is what each variable *means*;
this is where the values are read from and which one wins.

| | Source | Read by |
|---|---|---|
| 1 | `<state-dir>/config.json` | every process — the board, the CLI, the MCP server |
| 2 | `<cwd>/.env` | the same, from **its own** working directory |
| 3 | the real environment | the same, and it beats both files |

`src/core/settings.ts` is all of it, applied once on import so that no module can read a
variable before the files have been folded in.

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

The pidfile and the restart log were already there; the configuration joins them.
`EXCALIDRAW_STATE_DIR` redirects all three, and it is read from the environment only — a file
cannot name the directory it is in.

## The file

A flat JSON object of the same names the environment uses. Numbers and booleans are written as
themselves and read as the strings an environment holds. [config.example.json](../config.example.json)
is the tracked copy:

```json
{
  "PORT": 3000,
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

**A port in the file carries the canvas URL with it.** `PORT` is what the server binds and
`EXPRESS_SERVER_URL` is what every client of it reads, so a `config.json` holding only the port
would otherwise move the board and leave the CLI, the MCP server and the auto-start probe
talking to the old one. Only when the port came from the state file and nothing else names a
URL: it does not start deciding for a `PORT` that was already in somebody's shell.

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
read its own `.env` into. Passing the latter is what let the launch directory decide what the
board is: a `.env` in whatever directory somebody typed the command in arrived in the board as
though it had been exported.

## Turning the files off

`EXCALIDRAW_NO_DOTENV=1` turns off **both** file layers, leaving only the real environment.
Every check sets it (`scripts/lib/spawn-canvas.mjs`), and it exists because of what layering
*under* the environment means in reverse: the only values a file can supply are exactly the ones
a caller deliberately removed. `check-workspace-settings.mjs` builds a server with no implement
agent to prove `/api/implement` answers 404, and on a machine with an `.env` it got the
operator's real coding agent back and started one — see
[trap-check-environment.md](trap-check-environment.md).

`EXCALIDRAW_ENV_FILE` names a file instead of `<cwd>/.env`. It has no effect under
`EXCALIDRAW_NO_DOTENV=1`, and it does not move `config.json`; `EXCALIDRAW_STATE_DIR` does that.

`scripts/check-launch-cwd-independent.mjs` holds all of this: it launches a board from a
directory holding a decoy `.env` and asserts the board is the state file's.
