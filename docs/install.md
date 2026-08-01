# Installing VibeMaxxing

**Start here.** This is the one document for getting a board up on Windows, macOS or Linux,
and every command in it says which shell it is for. [running.md](running.md) is the operator
and development procedure that comes after — the environment, the checks, the export — and it
is not what a first run needs.

It exists because the two start documents were each written for one machine and neither said
which. The front page's quick start was `PORT=3000 npm run canvas`, POSIX prefix syntax that is
a parse error in PowerShell and in cmd, and it told the reader to run `open <url>`, which is a
macOS program. In the other direction the mandatory pre-start step in `running.md` was a
PowerShell loop with no `lsof` or `ss` beside it. `scripts/check-readme.mjs` now fails on a
command in either this document or the README that only one platform can run.

## What you need

**Node.js 20 or newer**, and nothing else. That is the floor `package.json`'s `engines.node`
declares and the one CI measures against ([running.md](running.md#and-what-a-pull-request-runs)).
`node --version` is the same command on all three platforms.

The canvas — drawing, the CLI, the MCP tools, the documentation cards, the terminal — needs no
account and no network. The workbench half needs **github.com** and an authenticated
[`gh`](https://cli.github.com): issue blocks, the project-board mirror and implementations all
read it, and no other forge is supported. [running.md](running.md#what-it-requires-githubcom)
is that boundary, and [without-github.md](without-github.md) is what a board keeps and loses at
each level of not having it — installing without `gh` is a real way to run this tool, not a
half-installed one.

## The one command

The same line on every platform, in PowerShell, in cmd, in Terminal, or in any POSIX shell:

```
npx -y @vitorengers/vibemaxxing
```

It starts the canvas server, opens it in your browser and prints one line:

```
VibeMaxxing 0.1.0 — http://127.0.0.1:3737
```

There is no port to choose and nothing to kill first. The launch takes 3737, or the next free
port above it if something already holds that one, and prints the port it got. Run it a second
time and it prints the same line and brings the existing tab forward.

What differs per platform is only how you reach a shell to type it in:

| Platform | Where to type it |
|---|---|
| Windows | Windows Terminal, PowerShell or `cmd` — from the Start menu, or `Win`+`X` |
| macOS | Terminal, in Applications ▸ Utilities |
| Linux | Whatever your desktop calls its terminal |

`--no-open` launches without a browser. A tab has to be open for anything that renders —
screenshots, PNG and SVG export, viewport control and Mermaid conversion all happen in the
frontend — so `--no-open` is for a script rather than for a person.

## Or one double-click

[`launchers/`](../launchers) holds one tracked file per platform, each a wrapper around exactly
the command above. Download the one for your machine from the repository; nothing else is
needed.

| File | Platform | How it is used |
|---|---|---|
| [`launchers/vibemaxxing.cmd`](../launchers/vibemaxxing.cmd) | Windows | Double-click it. |
| [`launchers/VibeMaxxing.command`](../launchers/VibeMaxxing.command) | macOS | Double-click it in Finder; it opens in Terminal. |
| [`launchers/vibemaxxing.desktop`](../launchers/vibemaxxing.desktop) | Linux | Copy it into `~/.local/share/applications/` and it appears in the launcher. |

They are not in the npm package, on purpose, and there is no signed application to download —
[launchers.md](launchers.md) is what each one does, the two machines they cannot help, and why
a Node SEA, an Electron shell and a notarised binary were each rejected.

## Installing it rather than fetching it each time

```
npm install -g @vitorengers/vibemaxxing
```

That puts `vibemaxxing` on the path, with `vibemax` beside it as a shorter alias of the same
binary. Everything below that says `npx -y @vitorengers/vibemaxxing` can then be `vibemaxxing`.

## Into a coding agent

The agent skill is the recommended path for Claude Code, Codex CLI, Cursor and OpenCode, and it
needs no MCP configuration and no clone:

```
npx -y @vitorengers/vibemaxxing install-skill --dir <skills-root>
```

Let the agent pick its own skill root and scope. For an MCP client instead — Claude Desktop,
Antigravity — the per-client configuration is in the
[README](../README.md#configure-mcp-clients) and the tools themselves in
[mcp-server.md](mcp-server.md).

## From source

For working on VibeMaxxing itself. Nothing here is platform-specific until the last step:

```
git clone https://github.com/vitorengers/vibemaxxing.git
cd vibemaxxing
npm ci
npm run build
node dist/server.js
```

`npm run build` is the frontend and then the server, in that order, because the server serves
the built frontend. `node dist/server.js` is the canvas; [cli.md](cli.md) is the CLI over the
same build, and `node dist/index.js` is the MCP stdio server.

**That canvas comes up blank, and it is meant to.** A clone has no project registered, so the
board on screen is the one that belongs to nobody and nothing on disk is behind it — including
the `docs/board.excalidraw` this repository keeps of itself.
[The first run](running.md#the-first-run-register-the-clone-as-its-own-project) is the three
steps that make the clone its own first project.

### Setting a variable, in three shells

The board reads its configuration from [`config.json`](configuration.md) in a per-user state
directory, from a `<cwd>/.env`, and from the environment — in that order, each beating the one
before. The first two are files and are the same on every platform; only the third has a
spelling per shell. `PORT` is the example below because it is the one a start document keeps
reaching for; [running.md](running.md#the-environment) is the whole table of them.

**PowerShell** — assignment is a statement of its own, and `$env:` is the namespace:

```powershell
$env:PORT = '3737'
$env:EXCALIDRAW_TERMINAL = '1'
node dist/server.js
```

**cmd** — `set`, with no spaces around the `=`:

```bat
set PORT=3737
set EXCALIDRAW_TERMINAL=1
node dist\server.js
```

**bash, zsh, or any POSIX shell** — the prefix form sets the variables for that one command:

```bash
PORT=3737 EXCALIDRAW_TERMINAL=1 node dist/server.js
```

Only the last of those three is a single line, and that is the whole reason the front page kept
being written in it. The other two are two lines and run everywhere.

### Opening the board yourself

**The short answer is to run `vibemaxxing` again.** Against a board that is already running it
starts nothing and simply opens the tab, and it is the thing that knows the board's secret: since
the board answers `401` to any request that does not carry it, the bare address opens a page that
loads and then stays empty ([SECURITY.md](SECURITY.md)).

If you have to build the address yourself — a desktopless machine, a browser that is not the
registered handler — it is the URL with `?t=` and the contents of `server-<port>.token` from the
state directory in [configuration.md](configuration.md):

```powershell
$secret = Get-Content "$env:LOCALAPPDATA\Excalidraw-Canvas\server-3737.token"
Start-Process "http://127.0.0.1:3737/?t=$secret"
```

```bash
# macOS
open "http://127.0.0.1:3737/?t=$(cat ~/Library/Application\ Support/excalidraw-canvas/server-3737.token)"
# Linux
xdg-open "http://127.0.0.1:3737/?t=$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/excalidraw-canvas/server-3737.token")"
```

The page takes the secret back out of the address bar as soon as it has read it, so what is left
on screen, and in your history, is the plain address.

`VIBEMAXXING_OPEN_COMMAND` replaces the one the tool picks, for a machine that has none of
these — a desktopless Linux box, or a browser that is not the registered handler.

## When it does not come up

- **`node: command not found`, or a version below 20.** Install Node from
  [nodejs.org](https://nodejs.org) and open a *new* shell; the path is read at start-up.
  On macOS a launcher can report this on a machine that does have Node, when it was installed
  by `nvm` — [launchers.md](launchers.md) says why, and typing the `npx` command in a terminal
  is the answer.
- **The tab opens on an empty canvas with no project tabs.** Two causes, and `GET /health`
  separates them: it reports the `pid` answering and whether that server has a registry. If the
  `pid` is the one you started, nothing is wrong — a board with no project registered has no
  board file behind it, and
  [the first run](running.md#the-first-run-register-the-clone-as-its-own-project) is how it
  gets one. If it is some other `pid`, something else is already on that port answering healthy,
  usually a canvas an editor's MCP client auto-started —
  [trap-stale-server.md](trap-stale-server.md) and
  [running.md](running.md#before-you-start-kill-what-is-already-listening) are that trap and the
  way out of it.
- **Port 3000.** Do not move the board onto it. It is the default of most tutorial servers and
  on at least one Windows machine a portproxy rule maps it to itself, so the server looks
  healthy and every request hangs — [trap-port-3000.md](trap-port-3000.md).
- **A registered project shows nothing from GitHub.** The board reads github.com only, through
  `gh`. `gh auth status` first, then
  [running.md](running.md#what-it-requires-githubcom).

## After it is up

- [workspaces.md](workspaces.md) — registering your project, and the `board.config.json` that
  travels with it.
- [board-sections.md](board-sections.md) — `Alt+P` and `Alt+G`, the two halves of this
  repository's own board.
- [index.md](index.md) — every other document, and what it covers.
