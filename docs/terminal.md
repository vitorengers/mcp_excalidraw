# The terminal

A shell running in the project, drawn as a block on the **right** of the board — opposite the
GitHub project mirror on the left. Type into it and its output arrives as it is produced.

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
workspace": PowerShell on Windows, `bash` on everything else, and `bash` inside the distro for
a WSL-backed project. PowerShell rather than `cmd.exe` because `pwd`, `ls` and `cat` all mean
something there, and a terminal whose first command fails on the platform's own spelling is a
poor first impression.

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

## A PTY, where there is one

The shell is given a **pseudoterminal**. That is what makes `stdin.isTTY` true inside it, and
`stdin.isTTY` is the first question every full-screen program asks — `vim`, `top`, and Claude
Code, which is the one that prompted this. On three pipes, `claude` waited three seconds for
something on stdin, decided it was being piped to, took its `--print` path and had nothing to
print about. With a terminal it starts its interface, and the block draws it.

The binding is [`@lydell/node-pty`](https://www.npmjs.com/package/@lydell/node-pty), an
`optionalDependency`, loaded with a runtime `import()`. The objection this feature was
originally built around was that a PTY would be "the first thing here that needs a compiler to
install"; that fork answers it by shipping the binary per platform as its own optional
dependencies — `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`,
`linux-arm64` — so `npm install` fetches a prebuilt `.node` and never runs `node-gyp`. On any
platform it has no binary for, npm skips it, the import fails, and the session falls back to
the pipes described below.

**The session says which it got.** `mode` is `pty` or `pipe` in `TerminalSessionSummary`, and
the block shows it in the header, because a feature that behaves differently on two machines
with no way to tell which is which is worse than one that only does less.

```
EXCALIDRAW_TERMINAL_PTY=0
```

forces the pipe. It exists so the fallback can be exercised on a machine where the binary *is*
present, which is how `scripts/check-terminal-pty.mjs` covers it.

Three things follow from the mode, and they are the whole of the difference:

- **The default shell is spelled differently.** `powershell.exe -NoLogo -NoProfile -Command -`
  reads commands from stdin, and PowerShell *refuses that outright* when stdin is a terminal —
  it prints its usage and exits. With a PTY the default is the plain REPL, which is also what
  gives line editing, history and a coloured prompt.
- **The echo moves.** A shell reading a pipe echoes nothing, so the session writes what it was
  sent into the transcript itself; without that a socket connecting later would replay answers
  with no questions in them. A shell on a terminal echoes for itself, and a session that kept
  its own echo would show every keystroke twice.
- **`resize` is pushed rather than recorded.** A program repaints to the width it was told, so
  the grid at `src/core/terminal-block.ts` is load bearing now rather than a label: it is what
  the shell is told *and* what the emulator draws, so the two cannot disagree. With no PTY there
  is still no `TIOCSWINSZ` to send, and the number is kept for what it was always good for — the
  block a second viewer draws.

**Streaming is unchanged and is still the point.** Every agent this board runs produces a live
stream and `runAgent` buffers the liveness away — `stdout += chunk`, read once the process exits
— which is why a block can say a run is `running` and nothing more. Here a command that prints,
pauses and prints again arrives as two messages while the process is still alive, and
`scripts/check-terminal.mjs` asserts exactly that.

## The routes

| | |
|---|---|
| `POST /api/terminal` | open a session — **202** with the session, **409** if one is open |
| `GET /api/terminal` | the session and its scrollback, or `session: null` |
| `POST /api/terminal/input` | `{ data }` written to the shell — **202** |
| `POST /api/terminal/resize` | `{ cols, rows }` the block now stands for |
| `DELETE /api/terminal` | close it, and take what it was running with it |

`input` carries **keystrokes, not lines**, and nothing is appended to them. What a terminal
sends for Enter is a carriage return, `\r`; Ctrl+C is `\x03`; an arrow is `ESC [ A`. A route
that added a newline to each of those would turn three of them into something else. Scripting
it by hand, that is the one thing to know: send `pwd\r`, not `pwd\n` — PowerShell's line editor
takes a bare `\n` as "continue this command on the next line".

Output travels on the existing per-workspace WebSocket as `terminal_output`, alongside
`terminal_session`, `terminal_resized` and `terminal_exit`. Per workspace, like every element
event: a shell belongs to one project and its output must not reach another board.

## Scrollback lives on the server

Bounded at 200,000 characters and replayed to any socket that connects while a session is
running — a reload, a tab switched away and back, a second window. It is held there rather than
on the shape because the shape is derived (below): a transcript in `customData` would be
synced, exported and committed.

**The ceiling is trimmed between escape sequences, not through one.** On a plain byte stream any
offset is a boundary, which is what `buffer.slice(-LIMIT)` assumed. On a stream from a PTY it is
not: a cut through `ESC [ 3 1 m` leaves `1m`, which every viewer replaying the scrollback then
prints as two characters nobody wrote, and a cut through an OSC title leaves a fragment that
swallows whatever comes next up to the following terminator. `trimScrollback()` moves the offset
forward past the sequence it landed in. The ceiling is still a ceiling; the exact offset is what
gives.

## Closing takes the tree

`DELETE` kills the process — on Windows through `taskkill /T`, because killing the shell alone
leaves the command running inside it. A session closed while something was running would
otherwise leave that something behind with nothing left to stop it, which is the constraint
`docs/issue-block.md` already records about a reset: nothing here can reach into a process the
server no longer owns.

Every session is closed when the server goes down, and with a PTY that promise needs help. A
piped shell kept it by itself — its stdin was the server's, and a closed pipe is an EOF it exits
on. A shell on a terminal has no such tie: on Windows the console is serviced by a `conhost` the
pseudoconsole owns, the shell is reparented onto it, and a server killed outright — which is
what `kill` is on Windows, with no handler of the server's getting to run — left a PowerShell
attached to a console nobody was reading, on roughly half of the tries. So each PTY session gets
a **keeper**: one detached process that watches the two pids and does what the server would have
done. It exits the moment the shell does, which for an ordinary close is immediately.

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

Nothing about the PTY changed this. The emulator is DOM, the transcript is the server's, and
neither has ever been an element.

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
positioned over its bounds (`frontend/src/components/TerminalPanel.tsx`). Inside that overlay is
**xterm.js**, not a `<pre>`. With a PTY behind the session the stream stops being text: it is
cursor moves, colours, an alternate screen and a program repainting itself into all three, and
printed into a `<pre>` that arrives as the literal `[33m` the observation behind #75 showed on
screen. So the parsing happens in the block, and what it draws is a screen rather than a log.

Where it differs from the documentation card is the zoom. That card stays the same size on
screen at any zoom, because it is a reading column pinned beside a shape. This one **is** the
shape: the zoom scales the font and leaves the grid alone, so a terminal zoomed out is the same
screen drawn smaller rather than a different number of columns.

## The font size is an input to the grid

The reader sets it, with `−` and `+` on the block's own header, between 8 and 24. What the zoom
multiplies is that size, so the two questions stay separate: the zoom is how close the board is,
and this is how big the text is on it.

It could not be a display tweak. xterm sizes its canvas as `cols` × `rows` × the font, and the
grid is derived from a cell that was measured at 13px — so a `+` that only assigned
`terminal.options.fontSize` would leave the emulator drawing past the frame, and everything past
the frame is clipped rather than scrolled (below). Bigger text, silently fewer visible columns,
and no scrollbar to reach them.

So `terminalGrid()` takes the font size as its second argument, and one size feeds three things:
the cell, the frame — the header, the prompt strip and the padding are all `em`, so the chrome
grows with the text it holds — and therefore the grid. **A larger font in the same block is
fewer columns and fewer rows**, reported down the same debounced route a corner drag uses. The
`cols`×`rows` in the header is the confirmation, because it is what came back from the shell.

Two decisions the observation left open:

- **It survives a reload**, in `localStorage` next to the theme, and it is **global rather than
  per board**: it is a preference about the reader's eyes, and the same eyes read every project.
- **It never reaches `customData`.** The block is derived and stripped at both doors, so a size
  stored on the shape would be dropped on the way to the store and read as the block forgetting
  it.

Buttons rather than a shortcut, for a reason beyond discoverability: while the terminal has the
keyboard every keystroke is the shell's, so `Ctrl+-` would reach the shell and not the block.

The one thing measured rather than assumed: xterm's cell **width** is linear in the font —
0.586px per font pixel across the whole range, against the 0.585 the block is drawn with — so
the columns fit at every step. Its cell **height** is not the font times the line height; xterm
measures the font's own line box first, which is a little over `1em`, so a row comes out nearer
`1.55 ×` the font than the `1.35` `TERMINAL_CELL` assumes. That gap is there at 13px with no
button pressed, which is why it is not this feature's to fix — see *What it does not do yet*.

**Resizing is Excalidraw's own.** The block is a real scene element, so dragging its corner
resizes it, dragging its middle moves it, and selecting it opens the usual style panel. That
works only because the overlay's body is `pointer-events: none` — an overlay that swallowed
clicks would take the shape's handles away with it. The reader's new size reaches the server as
`cols` × `rows`, derived from the block's **scene** size so that a pinch is not a resize, and
debounced so a drag is one request rather than one per frame.

That is the collision an emulator brings, and this is how it is resolved: **the pointer stays
with the canvas, and it is handed back only where the overlay says what it is for.** xterm would
like the pointer, for selection and for scrolling, and taking it would cost the block its
handles. So two small places take a click and nothing else does: the two font buttons on the
header, and the strip along the bottom — whose click focuses the terminal. From then on every keystroke goes to the shell — Ctrl+C, arrows, Escape included —
and none of them reach Excalidraw, which binds every bare letter to a tool. Clicking anywhere on
the canvas blurs it and gives the keyboard back. The strip says which of the two states it is
in.

## The hotkey

**Alt+T** brings the terminal into view, alongside **Alt+B** for the mirror. `Alt` for the
reason that one gives: Excalidraw owns the bare letters and much of `Ctrl+Shift`. It is matched
on `event.code` and bound on `window`, so it survives a keyboard layout where Alt produces a
different character and works from anywhere on the page. It stands down while text is being
edited — including while the terminal has the keyboard, where Alt+T has to be a keystroke the
shell receives rather than a jump.

It does one thing more than Alt+B: with no block on the board it places one first. The shape is
derived and is restored from nowhere, so deleting it would otherwise be permanent for the rest
of the session.

## Checked

- `scripts/check-terminal.mjs` — the guards, the workspace root, incremental output, input,
  409, the orphan, the replay, the export. Self-contained: it builds a throwaway workspace,
  starts its own servers and kills them.
- `scripts/check-terminal-pty.mjs` — that the shell sees a tty, that the echo moved with it,
  that a resize reaches the child, that the scrollback is cut between sequences, and that with
  no binding the server still starts and says `pipe`.
- `scripts/check-terminal-browser.mjs` — the block, in Chrome over the DevTools protocol.
  Placement, Alt+T, a command typed with real keystrokes, a corner dragged with a real pointer,
  and the store still holding none of it.
- `scripts/check-terminal-ansi-browser.mjs` — also in Chrome: an SGR escape drawn as a colour
  rather than as four characters, a real Ctrl+C interrupting a running command, and the block's
  corner still resizing it afterwards.
- `scripts/check-terminal-font.mjs` — the arithmetic behind the size buttons: the cell, the
  frame and therefore the grid all move with the font, the grid never grows on the way up the
  range, and no size in it asks for a screen the block cannot hold.
- `scripts/check-terminal-font-browser.mjs` — the buttons themselves, in Chrome. Clicked with a
  real pointer, the grid the *shell* was told changing with them, a line exactly as wide as the
  header's claim drawn with its last column inside the block, the shape still selectable and
  still resizable by its corner afterwards, and the size still there after a reload.

All six were written first and seen to fail against the code as it stood.

Beyond them, and not automatable at a sensible price: `claude` typed into the block on a real
board, its interface drawn, a question answered, and Ctrl+C twice getting back to the prompt.
`CLAUDE.md` is explicit that compiling is not working, and this change is mostly about what the
browser does.

## What it does not do yet

- **Nothing streams the agents into it.** That is the destination the observation behind #51
  named, and it is a second producer on this surface rather than part of building it: tap
  `issue-agent.ts` where the chunks arrive and broadcast them. It deserves its own issue.
- **The block claims about two rows more than it draws, at every font size.** `TERMINAL_CELL`
  takes a row to be `1.35 ×` the font, which is the line height xterm is given; xterm applies
  that to the font's *measured* line box, which is a little over `1em`, so a real row is nearer
  `1.55 ×`. The columns are unaffected — the width is linear and a shade conservative — and the
  bottom rows are the ones clipped. It predates the size buttons, which found it; correcting the
  constant changes what every shell is told on every board, and deserves its own issue and its
  own before-and-after check.
- **The transcript cannot be scrolled or selected with the mouse.** The body has to stay
  transparent to the pointer for the block underneath to remain a block, so the wheel and a drag
  both belong to the canvas. A taller block shows more; a full-screen program is unaffected,
  because it repaints rather than scrolls.
- **Alt+T fits the block to the viewport, which puts its top edge under Excalidraw's toolbar.**
  The path in the header reads through it awkwardly. Alt+B has the same shape of problem.
- **One session per board, and no way to restart one from the canvas.** A shell that exited is
  reported on the block; getting another means reloading the tab.
- **Whether a shell inside WSL gets a tty of its own has not been established.**
  `scripts/check-terminal.mjs` runs a real WSL-backed session through `wsl.exe` under the
  ConPTY and it behaves — the prompt is there, `pwd` answers with the inner path — but nothing
  yet asserts `isTTY` on the far side of the distro boundary.
