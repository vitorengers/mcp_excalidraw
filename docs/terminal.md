# The terminal

Shells running in the project, drawn as blocks on the **far left** of the board, one gap beyond
the GitHub project mirror. Type into one and its output arrives as it is produced. A block
carries a **strip of tabs**, one per shell, and a tab can be given a block of its own.

This spawns a process that runs **whatever arrives over an API with no authentication**. The
issue block, which `docs/issue-block.md` calls the most dangerous thing this server does, at
least only ever runs one fixed prompt. This is strictly worse, so it copies that feature's
guards and the copy is deliberate:

- it only exists when `EXCALIDRAW_TERMINAL` is set — unset, every route is a 404, not a 403 and
  not an empty session;
- it refuses unless the server is bound to loopback;
- **at most eight sessions per board.** The ninth request gets 409, and the refusal names the
  cap.

That third guard used to read "one session per board", and the change is a **relaxation rather
than a removal**. A count is what stops a page that can ask in a loop from asking for as many
shells as it likes, so the cap is a number rather than "unbounded":
`TERMINAL_SESSION_LIMIT` in `src/core/terminal-session.ts`. Eight is more tabs than anyone
opens on one board and still a number the machine notices — at the scrollback ceiling below it
is a worst case of 1.6 MB of transcript held server-side.

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
| `POST /api/terminal` | open one more session — **202** with the session, **409** past the cap |
| `GET /api/terminal` | `sessions`, each with its own scrollback, and the `limit` |
| `POST /api/terminal/input` | `{ sessionId, data }` written to that shell — **202** |
| `POST /api/terminal/resize` | `{ sessionId, cols, rows }` the block now stands for |
| `DELETE /api/terminal?sessionId=` | close that one, and take what it was running with it |

**Every route that addresses a session takes its id**, and that is the whole of what a strip of
tabs needed from the server: `input`, `resize` and `DELETE` used to resolve *the* session from
the workspace, so on a board with two of them they would have addressed whichever one the map
yielded first.

The id is optional, and its absence is never guessed at. With one session open there is nothing
to be ambiguous between and the routes stay scriptable by hand; with several, an unnamed request
is a **400 that lists them**. An id that names no session is a 404.

`input` carries **keystrokes, not lines**, and nothing is appended to them. What a terminal
sends for Enter is a carriage return, `\r`; Ctrl+C is `\x03`; an arrow is `ESC [ A`. A route
that added a newline to each of those would turn three of them into something else. Scripting
it by hand, that is the one thing to know: send `pwd\r`, not `pwd\n` — PowerShell's line editor
takes a bare `\n` as "continue this command on the next line".

Output travels on the existing per-workspace WebSocket as `terminal_output`, alongside
`terminal_sessions`, `terminal_session`, `terminal_resized` and `terminal_exit`. Per workspace,
like every element event: a shell belongs to one project and its output must not reach another
board. **Each of the three streaming messages names its `sessionId`**, for the same reason the
routes do.

`terminal_sessions` is the connect-time replay and it carries **every live session**, empty list
included. It is what a viewer reconciles its tabs against, so a session that ended while the tab
was disconnected has to be absent from a list rather than merely unmentioned — otherwise the
block would keep a tab for a shell that has gone. It is sent only when the feature is switched
on, so a board that never turned it on is told nothing at all about it.

## Scrollback lives on the server

Bounded at 200,000 characters **per session** and replayed to any socket that connects while a
session is running — a reload, a tab switched away and back, a second window. It is held there
rather than on the shape because the shape is derived (below): a transcript in `customData`
would be synced, exported and committed.

Per session rather than a per-board budget, and that is a decision rather than an oversight. A
shared budget would let one noisy tab eat another's history, so how far back a board remembered
would depend on which tab had been busy. The cap on sessions is what bounds the total.

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

## Tabs, and a tab that becomes a block

A block holds a **strip of tabs**, one per shell, labelled with the session's id — `s1`, `s2` —
which is short and readable because a tab strip is no place for a generated id. The tab on top
is the one being drawn and the one the keyboard goes to; clicking another switches to it, and
the keyboard follows the click.

**One emulator per session, all of them alive.** Switching does not dispose the screen you left
and rebuild it on the way back: an emulator is a screen being written to rather than a log being
displayed, so a rebuild would replay the transcript into a fresh parser and a `vim` left open in
a background tab would come back as its own scrollback. The screens are stacked and the ones
that are not on top are hidden with `visibility` rather than `display`, because an emulator
opened into a box of no size measures its cell against nothing and stays the wrong size.

Four controls sit at the end of the strip:

| | |
|---|---|
| `+` | one more shell in this block. Greyed out, not hidden, once the board is at the cap |
| `×` | on each tab: end that shell, with the tree-kill semantics below, and drop the tab |
| `⧉` | give the tab on top a **block of its own**, placed beside this one |
| `⇥` | put this block's tabs into the **nearest other** terminal block, and drop this block |

`⧉` and `⇥` are what "separate" and "join" turned out to mean here, and the choice was between
that and split panes inside one block. A detached tab becomes an ordinary shape, so moving it,
resizing it and putting it where you want it are all things the canvas already does; a splitter
inside a block would have been a drag handle competing with the shape's own. The same reasoning
picks the buttons over dragging a tab from one strip to another: dragging would mean the strip
taking drag events across the width of the block, which is more pointer than this overlay may
take (below). "Nearest" is not a guess either — the choosing *is* the drag. Put the block beside
the one you mean and press `⇥`.

**Closing the last tab takes the block with it**, and `Alt+T` opens a fresh session when there
are none. That is also the answer to something this document used to list as missing: a shell
that had exited could only be replaced by reloading the tab.

**The arrangement is not saved, and the sessions are.** Which tab is in which block lives in
`customData` on a derived shape, so it is stripped at both doors along with everything else
about the block — a tab list in the committed board file would name sessions that stopped
existing when the server did. A reload therefore puts every live session back into one block.
The shells, their transcripts and their sizes are the server's and come back exactly as they
were.

## The block is derived

The shape carries `customData.kind = "terminal"` — beside `sessions` and `active`, which are the
strip — and that mark is load bearing in the same three places the mirror's is:

- the browser strips it before `POST /api/elements/sync`, so it is never stored;
- `scripts/export-board.mjs` strips it again, so it never reaches `docs/board.excalidraw`;
- it is placed when a session opens and put back whenever the scene is replaced wholesale.

**A label bound to it goes with it.** Excalidraw offers to bind text to whatever is selected —
the hint appears on this block like any other — and that label carries no `kind` of its own, so
on its own terms it looks authored. Both doors drop anything whose container is derived;
without that, a text element whose container the store has never heard of ends up in the
committed board file.

There is a third place that rule has to be stated, and #99 is where it was missing: the mirror's
own measurement (`mirrorAnchors` in `src/core/project-board-layout.ts`). It left these blocks out
and took their labels in, so binding a title to a block the reader is expected to drag, and then
dragging it, moved the *other* region. All three now say the same thing about a label as about
its container.

Nothing about the PTY changed this. The emulator is DOM, the transcript is the server's, and
neither has ever been an element.

## Where it sits, and how it is drawn

Left to right the canvas reads **terminal | mirror | content**. "The far left" is a rule, not a
pixel column: the block is `left - 120 - width` of the region it has to clear, level with the
top of it — the mirror's own arithmetic, applied a second time. With a `githubProject` the
region to clear is the mirror; with none the mirror stays dormant, its slot is free, and the
block takes it, one gap left of the content. So every region follows a board that grew instead
of sitting at a coordinate somebody once picked, and the mirror and the terminal are each left
out of the other's measurement, or each pass would walk them further apart. Since #99 that
exclusion covers **a label bound to either**, which is the rule the autosync and the export
already stated.

Placed **once**, and since #99 the mirror is too. That used to be the difference between them:
this block is expected to be moved and resized, and a redraw that re-anchored it every twenty
seconds would undo that, while the mirror repainted on the timer and re-measured every time. The
re-measuring is what let the mirror drift away from the board on its own, so both regions now
resolve an origin the first time there is something to measure against and keep it.
`docs/project-board.md` has which edge the mirror pins and what that costs.

What still differs is what happens next. This block is the reader's to drag, and where it was
dragged is remembered and preferred over the rule above; the mirror has no such gesture, being
repainted from GitHub, so its origin only ever comes from the measurement.

**Which side follows from that.** Placed once means the block never moves aside, so it cannot
sit on the edge the board grows into — and the documentation, the only thing here that grows,
grows down and right. It was on the right until #96, and anything authored past the right edge
as it stood when the session opened ran straight into a block that would not budge. Behind the
mirror is the edge nothing runs into, and #99 is what makes that true of the mirror as well:
the region is pinned by its **left** edge now, so a column added on GitHub grows it rightward,
into the gap it keeps from the board, instead of stepping 324 leftward onto this block. #96
chose this side while the mirror still moved on every poll; the two decisions have to hold
together, and pinning that edge is what makes them.

The invariant this depends on is the other half of the same reading: **the documentation grows
down and right.** Content extended leftward does not move the mirror on the next poll any more —
neither region re-anchors while the session is open — but both re-measure on a reload, and the
mirror re-measured against content that now reaches further left comes back further left, with
the terminal placed from it. So content that has to extend leftward should still be moved right
instead; what changed is when the collision shows up, not that it does.

**One exception to "placed once."** A session opens on a `POST` that spawns a shell; the mirror
arrives on a poll that spawns a `gh`. On a board that has a project the block is therefore
placed before there is a mirror to anchor it to, lands in the mirror's own slot, and would sit
under it for the rest of the session. It is marked `customData.awaitingMirror` when that
happens, and the first board that lands moves it aside and takes the mark off — once, and only
while the block is still exactly where it was put, so a reader who has already dragged it keeps
their own placement.

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

## Where a cell comes from

A column and a row are answered differently, and #104 is why.

The **width** is a constant, because it really is one: this stack advances 0.586px per font
pixel at every size in the range, against the 0.585 `TERMINAL_CELL.width` is drawn with, so the
columns fit at every step with a pixel or two to spare.

The **height** is measured, in the browser, every time the grid is worked out. It could not be
a constant, and the one it had was wrong. `TERMINAL_LINE_HEIGHT` is `1.35` and reads as *"a row
is 1.35 × the font"* — but that is the `lineHeight` xterm is **given**, and xterm never applies
it to the font size. It measures the font's own line box first, as
`fontBoundingBoxAscent + fontBoundingBoxDescent`, and multiplies that:
`floor(charHeight × lineHeight)`, in `DomRenderer._updateDimensions`. For this stack the line
box is a little over `1em`, so a real row was nearer `1.55 ×` the font — the block divided by a
cell about 15% too short and handed the shell two or three rows past the bottom of a frame that
clips rather than scrolls. The default block claimed 22 rows and could draw 20.

A second measured constant would have been no more honest than the first. The metrics come back
as **whole pixels**, so the ratio is a staircase and not a line — 1.50 at 8px, 1.40 at 10px,
1.60 at 20px, 1.54 at 24px on the machine this was written on — and every member of
`TERMINAL_FONT_FAMILY` has a line box of its own, so a machine that resolves Consolas where this
one resolves Cascadia Code has a different answer at every size.

So `frontend/src/terminal-metrics.ts` asks the browser, by the same route xterm's own
`TextMetricsMeasureStrategy` takes — `measureText('W')` on a 2d context — and passes the line
box into `terminalCell()`, which does xterm's arithmetic on it. `src/core/terminal-block.ts`
stays arithmetic-only and DOM-free, so the offline checks still import it; a caller with nothing
to pass, or a browser too old to report `fontBoundingBoxAscent`, gets `TERMINAL_LINE_BOX` —
`1.2`, rounded **up** from the 1.12–1.17 this machine reports, because too tall costs the reader
a row at the bottom and too short costs them rows they cannot reach at all.

The font family and the line height live in `terminal-block.ts` for the same reason the
measurement does: the emulator is opened with both of them, so a grid derived from one font and
drawn in another would be two fonts agreeing on a number.

**Resizing is Excalidraw's own.** The block is a real scene element, so dragging its corner
resizes it, dragging its middle moves it, and selecting it opens the usual style panel. That
works only because the overlay's body is `pointer-events: none` — an overlay that swallowed
clicks would take the shape's handles away with it. The reader's new size reaches the server as
`cols` × `rows`, derived from the block's **scene** size so that a pinch is not a resize, and
debounced so a drag is one request rather than one per frame.

That is the collision an emulator brings, and this is how it is resolved: **the pointer stays
with the canvas, and it is handed back only where the overlay says what it is for.** xterm would
like the pointer, for selection and for scrolling, and taking it would cost the block its
handles. So three small places take a click and nothing else does: the two font buttons on the
header, the tab chips, and the strip along the bottom — whose click focuses the terminal. From
then on every keystroke goes to the shell — Ctrl+C, arrows, Escape included — and none of them
reach Excalidraw, which binds every bare letter to a tool. Clicking anywhere on the canvas blurs
it and gives the keyboard back. The strip says which of the two states it is in.

The tab strip is the newest of the three, and what takes the pointer is **the chips rather than
the row they sit in**. The row spans the card, the card is the block, and a full-width strip that
took the pointer would sit over the block's own top edge and swallow the resize handles along it.
The chips are inset from the card's edges for the same reason — Excalidraw's handles reach a few
pixels either side of the outline, which is also why the font buttons are as small as a target
can be and still be one. `scripts/check-terminal-tabs-browser.mjs` drags a corner after
everything else it does, which is what those two paragraphs are worth without a browser.

## The hotkey

**Alt+T** brings the terminal into view, alongside **Alt+B** for the mirror. `Alt` for the
reason that one gives: Excalidraw owns the bare letters and much of `Ctrl+Shift`. It is matched
on `event.code` and bound on `window`, so it survives a keyboard layout where Alt produces a
different character and works from anywhere on the page. It stands down while text is being
edited — including while the terminal has the keyboard, where Alt+T has to be a keystroke the
shell receives rather than a jump.

It does more than Alt+B, because the terminal has four ways of being absent and this is the one
answer to all of them: it scrolls to the blocks, places one if the board has none, and **opens a
session if none is running** — which covers a shell that exited, a board whose own attempt to
open one failed, and the last tab having been closed with its block. That last part is what
makes it a way back rather than a jump: the key used to stand down whenever no session was open,
which is to say in exactly the cases a reader reaches for it.

The key is on the block as well as in here. When a shell has gone the strip along the bottom
says so and says how to get another — `+` for a tab beside it, or this key — because a key
written down only in markdown is a key nobody finds, which is the half of #93 that was never
about the eraser.

## Erasing it does not get rid of it

The block is not `locked`, and `locked` is the only thing Excalidraw's eraser respects
(`if (element.locked) { return; }`). Locking it would take away the selection, the drag and the
corner resize that *are* the interface here, so the block stays erasable and **the erase is
undone instead**: the board notices, in `syncTerminalBlocks`, that it has lost a block whose
shells are still running, and puts one back where the reader had it — the size and the position
it was erased at, not re-anchored past the mirror. A block with two tabs comes back as one block
with two tabs, because what is remembered is per session and the restore groups the orphans by
the geometry they share.

That is the only answer that keeps the shells reachable. Nothing in the erase path kills one:
`DELETE /api/terminal` is never sent by the frontend for an erase, so a block that stayed gone
left a live process with a slot still taken, its output accumulating into state nothing drew,
and no way to Ctrl+C whatever was running in it — the keyboard reaches a shell only through the
overlay. That is what the observation behind #93 walked into.

**Once a shell has exited, an erase sticks.** That tab is a notice by then rather than a
terminal, and a notice the reader clears should stay cleared, so it is forgotten rather than
restored. Its block still comes back if any of its other tabs is alive. `+` or Alt+T starts
another.

The restore is on a short timer rather than immediate, because a block going missing is noticed
from inside the scene-change handler and the pointer that erased it may still be down. It puts
back only the block: the live scene is what goes into `updateScene`, since
`convertToExcalidrawElements` rebuilds each element from a skeleton with no `isDeleted` to
rebuild from, and handed the tombstones it would return everything else the eraser had just
taken.

## Checked

- `scripts/check-terminal.mjs` — the guards, the workspace root, incremental output, input,
  the orphan, the replay, the export. Self-contained: it builds a throwaway workspace,
  starts its own servers and kills them.
- `scripts/check-terminal-tabs.mjs` — two sessions in one board, input reaching the one it
  names and no other, a resize likewise, closing one leaving the other running, the cap
  answering 409 and naming itself, and a socket connecting late being given both transcripts.
  The cases that matter are the ones an ignored id would still pass a naive test on.
- `scripts/check-terminal-pty.mjs` — that the shell sees a tty, that the echo moved with it,
  that a resize reaches the child, that the scrollback is cut between sequences, and that with
  no binding the server still starts and says `pipe`.
- `scripts/check-terminal-browser.mjs` — the block, in Chrome over the DevTools protocol.
  Placement, Alt+T, a command typed with real keystrokes, a corner dragged with a real pointer,
  and the store still holding none of it.
- `scripts/check-terminal-tabs-browser.mjs` — also in Chrome: the strip rendering, `+` and `×`,
  switching tabs showing *that* session's screen rather than a replay into one emulator, a tab
  detaching into a second block, a detached tab re-joining a strip, and the block's corner still
  resizing it afterwards.
- `scripts/check-terminal-ansi-browser.mjs` — also in Chrome: an SGR escape drawn as a colour
  rather than as four characters, a real Ctrl+C interrupting a running command, and the block's
  corner still resizing it afterwards.
- `scripts/check-terminal-restore-browser.mjs` — also in Chrome: the real eraser tool dragged
  across the block, and the block back where it was with the same pid behind it; a control shape
  in the same drag that has to stay erased, so a restore that resurrected the whole scene could
  not pass; the block still absent from the store afterwards; and the key opening a session
  after `exit`, and on a page that never opened one, both without a reload.
- `scripts/check-terminal-font.mjs` — the arithmetic behind the size buttons: the cell, the
  frame and therefore the grid all move with the font, the grid never grows on the way up the
  range, and no size in it asks for a screen the block cannot hold.
- `scripts/check-terminal-font-browser.mjs` — the buttons themselves, in Chrome. Clicked with a
  real pointer, the grid the *shell* was told changing with them, a line exactly as wide as the
  header's claim drawn with its last column inside the block, the shape still selectable and
  still resizable by its corner afterwards, and the size still there after a reload.
- `scripts/check-terminal-rows-browser.mjs` — the vertical half of that, and #104's. At zoom 1,
  where a scene unit is a pixel, at the default size and at both ends of the range: the screen
  xterm drew inside the frame that holds it, the rows the *shell* was told no more than the
  frame can draw and no more than two fewer, and a marked last line printed into the bottom row
  and seen inside the block. Every number is read off the render, because a check that divided
  by the same wrong cell the code did would have agreed with it.

All ten were written first and seen to fail against the code as it stood.

Beyond them, and not automatable at a sensible price: `claude` typed into the block on a real
board, its interface drawn, a question answered, and Ctrl+C twice getting back to the prompt.
`CLAUDE.md` is explicit that compiling is not working, and this change is mostly about what the
browser does.

## What it does not do yet

- **Nothing streams the agents into it.** That is the destination the observation behind #51
  named, and it is a second producer on this surface rather than part of building it: tap
  `issue-agent.ts` where the chunks arrive and broadcast them. It deserves its own issue.
- **The transcript cannot be scrolled or selected with the mouse.** The body has to stay
  transparent to the pointer for the block underneath to remain a block, so the wheel and a drag
  both belong to the canvas. A taller block shows more; a full-screen program is unaffected,
  because it repaints rather than scrolls.
- **Alt+T fits the block to the viewport, which puts its top edge under Excalidraw's toolbar.**
  The path in the header reads through it awkwardly. Alt+B has the same shape of problem.
- **A tab is moved between blocks by a button, not by dragging it.** `⧉` detaches the tab on
  top and `⇥` merges into the nearest block, so the geometry is a block drag rather than a tab
  drag. Dragging a chip onto another block's strip would read better and would cost this
  overlay more pointer than it may take; if it is ever worth it, it is worth its own issue.
- **The tab layout does not survive a reload.** The blocks are derived, so which session was in
  which block is not saved, and a reload puts every live session back into one block.
- **A tab that has ended keeps its transcript but cannot be restarted in place.** `×` then `+`
  is a new session with an empty screen, in the same block.
- **Whether a shell inside WSL gets a tty of its own has not been established.**
  `scripts/check-terminal.mjs` runs a real WSL-backed session through `wsl.exe` under the
  ConPTY and it behaves — the prompt is there, `pwd` answers with the inner path — but nothing
  yet asserts `isTTY` on the far side of the distro boundary.
