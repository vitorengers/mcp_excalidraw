# The terminal

A shell running in the project, drawn as a block on the **right** of the board — opposite the
GitHub project mirror on the left. Type a command into it and its output arrives as it is
produced.

This spawns a process that runs **whatever arrives over an API with no authentication**. The
issue block, which `docs/issue-block.md` calls the most dangerous thing this server does, at
least only ever runs one fixed prompt. This is strictly worse, so it copies that feature's
guards and the copy is deliberate:

- it only exists when `EXCALIDRAW_TERMINAL` is set — unset, every route is a 404, not a 403 and
  not an empty session;
- it refuses unless the server is bound to loopback;
- **one session per board.** A second request gets 409 rather than a second shell.

## Turning it on

```
EXCALIDRAW_TERMINAL=1
```

`1`, `true`, `on`, `yes`, `enabled` or `default` all mean "the default shell for this
workspace": PowerShell (`-NoLogo -NoProfile -Command -`) on Windows, `bash` on everything else,
and `bash` inside the distro for a WSL-backed project. PowerShell rather than `cmd.exe` because
`pwd`, `ls` and `cat` all mean something there, and a terminal whose first command fails on the
platform's own spelling is a poor first impression.

Anything else is taken as the command to run, which is how a machine that prefers something
else says so — and how `scripts/check-terminal.mjs` puts a stub where a shell would be.

It needs a **registered workspace**: a shell has to run somewhere, and the `default` board is
what the server uses when no registry is configured, so it has no project to be in. Opening a
session there is a 400 rather than a shell in whatever directory the server happens to have been
started from.

The shell starts in the workspace root, resolved by `buildAgentCommand()`, which is the same
resolution both agents use. That matters for one case in particular: a WSL-backed project runs
through `wsl.exe -d <distro> --cd <inner path>`, because a Windows UNC path is not a working
directory `git` inside the distro can act on. `pwd` in such a session reports the inner path.

## A pipe, not a PTY

The shell's stdin, stdout and stderr are pipes. That is a decision, and it has a cost.

A real PTY is what a full-screen program needs — cursor addressing, a window size, line
editing, and Claude Code's own interface. Every PTY binding for Node is a **native module**,
which would be the first native dependency in a package published to npm and the first thing
here that needs a compiler to install.

So what works is what a pipe gives: run a command, read what it prints, one stream with stderr
interleaved into it. What does not work is anything that repaints a screen. `vim` is not a
terminal this can host, and neither, yet, is an interactive `claude`.

**What it does do is stream.** That is the whole reason this exists as a surface. Every agent
this board already runs produces a live stream and `runAgent` buffers the liveness away —
`stdout += chunk`, read once the process exits — which is why a block can say a run is
`running` and nothing more. Here a command that prints, pauses and prints again arrives as two
messages while the process is still alive, and `scripts/check-terminal.mjs` asserts exactly
that, because it is the difference between a terminal and a slower way of getting a final
answer.

## The routes

| | |
|---|---|
| `POST /api/terminal` | open a session — **202** with the session, **409** if one is open |
| `GET /api/terminal` | the session and its scrollback, or `session: null` |
| `POST /api/terminal/input` | `{ data }` written to the shell's stdin — **202** |
| `POST /api/terminal/resize` | `{ cols, rows }` the block now stands for |
| `DELETE /api/terminal` | close it, and take what it was running with it |

Output travels on the existing per-workspace WebSocket as `terminal_output`, alongside
`terminal_session`, `terminal_resized` and `terminal_exit`. Per workspace, like every element
event: a shell belongs to one project and its output must not reach another board.

**The transcript is echoed server-side.** A shell reading a pipe echoes nothing, so the line
that was typed is written into the scrollback before being written to stdin. Without that, a
socket connecting later would replay answers with no questions in them.

`resize` is **recorded, not pushed**. With no PTY there is no `TIOCSWINSZ` to send, so nothing
inside the shell is told; what the size is for is the block a second viewer draws, and the one
piece of state a PTY would need on the day one arrives.

## Scrollback lives on the server

Bounded at 200,000 characters and replayed to any socket that connects while a session is
running — a reload, a tab switched away and back, a second window. It is held there rather than
on the shape because the shape is derived (below): a transcript in `customData` would be
synced, exported and committed.

## Closing takes the tree

`DELETE` ends stdin first, which is how a piped shell exits of its own accord, then kills the
process — on Windows through `taskkill /T`, because `child.kill()` reaches the shell and not the
command running inside it. A session closed while something was running would otherwise leave
that something behind with nothing left to stop it, which is the constraint
`docs/issue-block.md` already records about a reset: nothing here can reach into a process the
server no longer owns.

Every session is closed when the server goes down, for the same reason.

A session that ends on its own — `exit`, or a crash — frees the slot too, and the block says so
rather than sitting there looking idle.

## The block is derived

The shape carries `customData.kind = "terminal"`, and that mark is load bearing in the same
three places the mirror's is:

- the browser strips it before `POST /api/elements/sync`, so it is never stored;
- `scripts/export-board.mjs` strips it again, so it never reaches `docs/board.excalidraw`;
- it is placed when a session opens and put back whenever the scene is replaced wholesale.

**A label bound to it goes with it.** Excalidraw offers to bind text to whatever is selected —
the hint appears on this block like any other — and that label carries no `kind` of its own, so
on its own terms it looks authored. Both doors drop anything whose container is derived;
without that, a text element whose container the store has never heard of ends up in the
committed board file.

## Where it sits, and how it is drawn

"The right side" is a rule, not a pixel column: `maxX + 120`, level with the top of whatever the
board has authored. That is the mirror's own arithmetic with the sign flipped — the mirror is
`minX - gap - width` (`src/core/project-board-layout.ts`) — and it means both regions follow a
board that grew instead of sitting at a coordinate somebody once picked. The mirror and the
terminal are each left out of the other's measurement, or they would walk away from the content
in opposite directions on every pass.

Placed **once**, unlike the mirror, which repaints on a timer: this one is expected to be moved
and resized, and a redraw that re-anchored it every twenty seconds would undo that.

The block itself is a plain rectangle, and everything that reads as a terminal is a DOM overlay
positioned over its bounds (`frontend/src/components/TerminalPanel.tsx`). An overlay for the
reason the documentation card is one: text on the canvas is drawn by Excalidraw, and a shell's
output is neither a label nor a shape. It is also what keeps the transcript out of every path
that saves a board, because it was never an element.

Where it differs from the documentation card is the zoom. That card stays the same size on
screen at any zoom, because it is a reading column pinned beside a shape. This one **is** the
shape: it fills the block's bounds and its font scales with the board, so a terminal zoomed out
reads as a small dark box instead of a giant font in a tiny frame.

**Resizing is Excalidraw's own.** The block is a real scene element, so dragging its corner
resizes it, dragging its middle moves it, and selecting it opens the usual style panel. That
works only because the overlay's body is `pointer-events: none` — an overlay that swallowed
clicks would take the shape's handles away with it. The reader's new size reaches the server as
`cols` × `rows`, derived from the block's **scene** size so that a pinch is not a resize, and
debounced so a drag is one request rather than one per frame.

The prompt row is the one part that takes the pointer, and it stops keystrokes from reaching the
canvas: Excalidraw binds every bare letter to a tool, so typing `pwd` would otherwise switch to
freedraw and then to the diamond.

## The hotkey

**Alt+T** brings the terminal into view, alongside **Alt+B** for the mirror. `Alt` for the
reason that one gives: Excalidraw owns the bare letters and much of `Ctrl+Shift`. It is matched
on `event.code` and bound on `window`, so it survives a keyboard layout where Alt produces a
different character and works from anywhere on the page. It stands down while text is being
edited — including in this feature's own prompt, where Alt+T has to be a keystroke rather than a
jump.

It does one thing more than Alt+B: with no block on the board it places one first. The shape is
derived and is restored from nowhere, so deleting it would otherwise be permanent for the rest
of the session.

## Checked

- `scripts/check-terminal.mjs` — the guards, the workspace root, incremental output, input,
  409, the orphan, the replay, the export. Self-contained: it builds a throwaway workspace,
  starts its own servers and kills them.
- `scripts/check-terminal-browser.mjs` — the block, in Chrome over the DevTools protocol.
  Placement, Alt+T, a command typed with real keystrokes, a corner dragged with a real pointer,
  and the store still holding none of it.

Both were written first and seen to fail against the code as it stood.

## What it does not do yet

- **Nothing streams the agents into it.** That is the destination the observation behind #51
  named, and it is a second producer on this surface rather than part of building it: tap
  `issue-agent.ts` where the chunks arrive and broadcast them. It deserves its own issue.
- **The transcript cannot be scrolled or selected with the mouse.** It is pinned to the newest
  line, because the body has to stay transparent to the pointer for the block underneath to
  remain a block. A taller block shows more.
- **No history, no completion, no Ctrl+C.** One line in, one line at a time.
- **Alt+T fits the block to the viewport, which puts its top edge under Excalidraw's toolbar.**
  The path in the header reads through it awkwardly. Alt+B has the same shape of problem.
- **One session per board, and no way to restart one from the canvas.** A shell that exited is
  reported on the block; getting another means reloading the tab.
