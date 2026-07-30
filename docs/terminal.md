# The terminal

Shells running in the project, drawn as blocks **between the GitHub project mirror and the
board's own documentation**, one gap left of the documentation. Type into one and its output
arrives as it is produced. A block carries a **strip of tabs**, one per shell, and a tab can be
given a block of its own — to the right, with the documentation stepping aside to make the room.

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

## The environment it is given

The shell inherits the server's environment, and `agentEnv()` in `src/core/issue-agent.ts`
adjusts exactly three keys of it on the way in. The agents are given the same function's result,
because a rule kept for the shell and not for them is how the two drift apart.

- **`PATH` gains the GitHub CLI**, where it is installed and missing. A server started before
  `gh` was installed hands out a PATH without it for the rest of its life, and `gh` is most of
  what anyone types in here.
- **`CLAUDE_CODE_CHILD_SESSION` is removed.** It is Claude Code's marker for "you are nested
  inside a session", set in every subprocess spawned from its Bash, PowerShell and Monitor
  tools, from hooks and from status line commands. An interactive `claude` that sees it is
  excluded from `--resume`, `--continue`, up-arrow history and the `claude agents` list —
  which for a block whose reason to exist is running `claude` (below) means the session is
  gone the moment the block is closed. The marker is deliberately *not* set for stdio MCP
  server subprocesses, on the grounds that they are long-lived and outlive the session that
  spawned them; this server is that class of process and gets no such exemption, so a board
  started once from a Claude Code tool call would stamp the marker onto every shell it opened
  hours later. Stripping it is the correction the exemption would have made. Non-interactive
  `claude -p` persists either way, so the agents were never at risk — they are covered because
  one rule is easier to keep than two.
- **`NO_COLOR` is removed when `CLAUDECODE` is beside it**, and only then. Claude Code sets
  `NO_COLOR=1` in the subprocesses its Bash, PowerShell and Monitor tools spawn, which is right
  for what those are: their output is read back as text rather than drawn on a screen. It
  arrives here by the same route the marker above does, and a terminal block is the opposite of
  a captured subprocess — measured on a real board, a block running Claude Code emitted **zero**
  colour sequences on the native workspace against 614 on the WSL one. The palette this document
  spends a whole section arguing about was being drawn for a program that had been told not to
  use colour at all.

**Claude Code says so itself, in its status line**, if you ever see this again from somewhere
else: `Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`. That is what the
block used to show, and a session started under it writes no transcript at all — not a
transcript that is merely hidden from the picker.

`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` reaches the same place and is not what is done here:
it overrides the exclusion unconditionally, including for a session that really is nested. The
two compose, if stripping ever turns out not to be enough.

**The condition on `NO_COLOR` is the decision, not an implementation detail.** It is a standard
an operator may hold deliberately (`no-color.org`), so a board that discarded it on sight would
be overriding the machine rather than correcting an inheritance. `CLAUDECODE` in the same
environment is what tells the two apart, and nothing else in reach can: the variable carries no
value that distinguishes them, and the persistent User and Machine environment blocks — where a
real preference would live, and where this one was *not* found — are not readable from here. So
it is conditional where the marker above is unconditional, and it sits outside
`STRIPPED_FROM_CHILDREN` for exactly that reason. `CLAUDECODE` itself stays: it is Claude Code
telling a child what spawned it, which is true of a shell the board opens.

**A WSL board never had this**, and not because anything here protects it. `buildAgentCommand`
runs such a workspace through `wsl.exe`, and WSL does not carry the Windows environment into the
distro unless `WSLENV` names the variable. So one board was in colour by accident of the
boundary and the other was not, on the same screen, which is what made an inherited variable look
like a defect in the terminal.

Nothing else is filtered. There is no allowlist and no per-project environment facility — the
board removes keys it has a reason to remove, and everything else the machine's environment
carries arrives untouched. `scripts/check-child-session-env.mjs` and
`scripts/check-no-color-env.mjs` assert both halves of that, on the PTY path, the pipe path and
the agent path; the second also asserts the half that keeps this a correction, a board whose
`NO_COLOR` came with no `CLAUDECODE` handing it on untouched.

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

Four things follow from the mode, and they are the whole of the difference:

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
- **A pipe carries no output translation, so the emulator supplies it.** A pseudoterminal turns
  the `\n` a program writes into `\r\n`; a pipe hands it on exactly as it was, and a bare line
  feed moves xterm's cursor down a row and leaves the column where it was. Every line then starts
  where the last one ended and the transcript walks diagonally off the right edge — #220, seen in
  an agent tab because a `-p` run is deliberately on pipes, but every pipe-mode session's. So the
  block sets xterm's `convertEol` for a session whose `mode` is `pipe`, and only for one:
  translating on a PTY would rewrite a bare LF that a repainting program meant as "down one row,
  same column". The server's bytes are untouched, which is the property #219 exists to protect —
  the raw tap, `extractGithubUrl` and `UsageMeter` all read them.
  `scripts/check-agent-stream-render-browser.mjs` reads the columns back off the emulator.

**Streaming is unchanged and is still the point.** A command that prints, pauses and prints
again arrives as two messages while the process is still alive, and `scripts/check-terminal.mjs`
asserts exactly that. It is what `runAgent` could not do while every run was a private child —
`stdout += chunk`, read once the process exited — which is why a block could say a run was
`running` and nothing more, and why an implementation now runs here instead.

## A session the board opened for itself

Starting an implementation opens one of these, in the worktree of the run, and the tab appears
with nobody clicking for it. That is #128, and it is what the terminal was built towards: #51
deferred it, and `docs/whats-next.md` carried it until now.

Three things make an agent's session different from a shell's, and they are the whole of the
difference — `TerminalSessionOptions` in `src/core/terminal-session.ts`:

- **a `directory`**, because a run happens in `<project>-worktrees/issue-<n>` rather than in the
  project. It is the `AgentDirectory` the agents already resolve, so the WSL case is not
  implemented a second time;
- **an `owner`** — which agent, and which issue — so the strip can label the tab `#128` rather
  than `s4`. A tab that arrives on its own has to say what it is; a shell the reader opened
  keeps its number, and its owner is null;
- **an `input`**, the prompt, and **an `interactive`** that says how it is delivered.

### Two kinds of agent tab, decided by the operator's own command line — or by the click

`EXCALIDRAW_IMPLEMENT_AGENT` is read for its *shape*, exactly the way `streamsUsage()` reads it
for `--output-format stream-json`. Nothing is appended to it, there is no second variable, and
nothing here assumes the command is Claude Code — `runsHeadless()` in `src/core/issue-agent.ts`
looks for one thing, `-p` or `--print` as a whole argument.

**The shape decides the default; the board can say "not this one".** The panel of an issue that
has not been started offers **Implement, and let me answer** beside **Implement / Fix**, and
`POST /api/implement` takes `interactive: true` for it. That was #220's comment, and the second
time it had been asked for — #174 was the first, and both had been answered with documentation
about a variable and a server restart, which is a setting nobody reading the board could find.

It works by *removing*, never adding. `withoutPrintFlags()` takes `-p` and `--print` off, and
with them `--output-format`, `--input-format` and `--include-partial-messages`, which
`claude --help` documents as working only with `--print` and which the CLI would refuse the
moment the print flag went. Everything else the operator wrote — a `--model`, an `--add-dir` —
survives untouched, and a command with no print flags in it comes back byte for byte. Nothing
downstream learns a new setting: `runsHeadless` still decides the pseudoterminal,
`buildAgentCommand` still decides how the prompt travels, `streamsUsage` still decides whether
there are token counts. The asymmetry is deliberate — a board cannot invent
`--output-format stream-json` for a command it does not own, so it cannot make an interactive
command headless, and the queue keeps the one it is configured with.

**And it refuses rather than degrades.** This is the one place a missing tab stops a run. With
the terminal off, with no PTY binding, with `EXCALIDRAW_TERMINAL_PTY=0` or with all eight tabs
taken, `interactive: true` is a **409** that says which of the three is missing, and no run
starts — a reader who asked for something to type into and silently got a private child with its
print flags stripped would have no interface, no token counts and nothing to answer, which is
worse than the run they would have got by not asking. The same click without the ask still works.
`scripts/check-implement-interactive-choice.mjs` holds both halves.

**With `-p`, everything is what it was.** The prompt is written to stdin and stdin is ended, and
that is why such a session is on pipes — a measurement rather than a preference. A
pseudoterminal has no end of file to send. On ConPTY a child reading stdin sees neither `^Z` nor
`^D` as one — measured against a Node child, which went on reading and never saw `end` — so a
`claude -p` handed its prompt through a PTY would wait forever for a prompt that never finished
arriving. The constructor therefore ignores the binding whenever `input` is set without
`interactive`, and `mode` says `pipe`, because a block that claimed otherwise would be the worse
failure. Such a tab is **read-only**, `readOnly` in the summary says so, the block labels it, and
`POST /api/terminal/input` answers **409** rather than 202 for bytes `write()` would drop.

**Without `-p`, the prompt travels as the command's last argument and the session keeps its
PTY.** `claude [options] [prompt]` takes one that way and starts an interface with it, so stdin
is never spent — which is the whole point, because stdin is what a reader types into. The
measurement above constrains prompt *delivery*, not interactivity. The argument is never
tokenized: on the host it is one more element of `argv`, which no shell parses; inside a distro
it is single-quoted into the string `bash -lc` reads, the one quoting that expands nothing.
Measured at ~5 kB with quotes, backticks and newlines in it, through ConPTY and back out of
`process.argv`, by `scripts/check-implement-interactive.mjs`.

**How an interactive run settles, and what ends it.** Three candidates were on the table —
scrape the transcript, `--session-id` plus the session record on disk, or a `Stop` hook posting
back through `--settings`. **Scraping won**, and the reason is not that it is the most robust: it
is the only one of the three that does not have the server appending Claude-Code-specific flags
to a command line it does not own, which is the rewrite `agent-usage.ts` refuses to make. The
prompt already ends by ordering the agent to print the pull request URL last, and that order is
unchanged — the prompt must not differ by where a run is hosted.

So an interactive run settles the moment its process ends, like any other, and what ends it is
the reader: `/exit`, or the tab's `×`, which is a kill. **Its exit code is therefore not read.**
A session someone closed after watching it succeed reports whatever a kill reports, so the
transcript is the verdict — `stripAnsi` first, because a screen carries the sequences that
painted it and a URL with an SGR reset in the middle of it is not a URL. Two consequences worth
having in front of you:

- **an unattended interactive run does not end by itself.** The queue starts runs with nobody
  watching, and a TUI returns to its own prompt rather than exiting, so such a run holds its
  block in `running` and one of the eight tab slots until somebody ends it or
  `EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT` fires. An interactive command is for attended work; the
  queue wants `-p`, and never asks for `interactive: true`.
- **the token figures go silent.** `--output-format` only works with `--print`, so an
  interactive command cannot ask for the stream `UsageMeter` reads. A real trade, not a bug.

**A tab is offered, never required.** `EXCALIDRAW_TERMINAL` and `EXCALIDRAW_IMPLEMENT_AGENT` are
separate switches and stay separate: with the terminal off, with no PTY binding, with
`EXCALIDRAW_TERMINAL_PTY=0`, or with all eight tabs already taken, the run happens in a private
child exactly as it did before any of this — `runAgent` falls through, and `GET /api/implement`
reports `terminal: null` for it. A 409 from the cap must never be what stops an implementation
from starting. The interactive path falls back the same way and for a reason of its own: with no
PTY there is no interface to draw either, since `stdin.isTTY` is false on pipes and a full-screen
program takes its non-interactive path there, so a command without `-p` on a machine with no
binding is run exactly as a headless one is. A run that *asked* for the interactive tab is the
one exception, and it is refused rather than fallen back — see above.

**A headless run settles the way it always did.** The process inside the tab is the process that
ran before, in the same checkout, reading the same prompt on stdin; the exit code and the
transcript go through the same `agentOutcome`, so `done` with a pull request URL and `failed`
with an error are decided by one piece of code for a watched run and an unwatched one alike.
`scripts/check-implement-terminal.mjs` covers the server, `scripts/check-implement-interactive.mjs`
covers the two shapes side by side, and `scripts/check-implement-terminal-browser.mjs` covers the
board.

## The routes

| | |
|---|---|
| `POST /api/terminal` | open one more session — **202** with the session, **409** past the cap |
| | body: optional `command` for what to run, optional `cwd` for where |
| `GET /api/terminal` | `sessions`, each with its own scrollback, and the `limit` |
| `POST /api/terminal/input` | `{ sessionId, data }` written to that shell — **202**, or **409** for a read-only session |
| `POST /api/terminal/resize` | `{ sessionId, cols, rows }` the block now stands for |
| `DELETE /api/terminal?sessionId=` | close that one, and take what it was running with it |

**`POST /api/terminal` takes a body now, and both fields are optional.** `command` names what to
run instead of the configured shell and `cwd` names where; a request with neither is the request
it always was. Neither grants anything the route did not already grant — a shell is a thing you
type commands and `cd` into — and all three guards are untouched. They exist because the server
itself has to ask for a session that is not the default one, and a facility only the server can
reach is one nothing can check by hand. `cwd` is **one path, spelled the way the workspace's own
environment spells it**: inside a WSL distro only the inner path is ever used, outside one only
the Windows path is.

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
| `⧉` | give the tab on top a **block of its own**, placed to its **right** |
| `⇥` | put this block's tabs into the **nearest other** terminal block, and drop this block |

`⧉` goes right, always, and not to whichever side happens to be free. It went **left** between
#124 and #200, and both directions are the same argument applied to a different order. While the
canvas read `terminal | mirror | content` the region was anchored past the mirror precisely
because it is placed once and cannot sit where the board grows, so a detach that went right
authored a block back into the direction #96 had emptied — and from the anchored origin the very
first one landed on top of the mirror. #200 turned the order round to
`mirror | terminals | documentation`, which puts the region's growing edge against the
documentation again; what makes that safe is the other half of the same change, **the
documentation moves aside** (`documentationClearance`). Unconditional either way, which is #124's
decision and unchanged: a rule that picked the emptier side would put the block somewhere the
reader cannot predict.

`⇥` is the other end of that. Merging drops a block, the region gives the room back, and the
documentation returns to **exactly** where it was authored — the round trip is computed from
where the documentation would stand with no block open rather than nudged by a delta, because a
delta applied twice a session walks the board right by its own rounding. The two gestures are the
only ones that move the documentation: a board switched to, an erased block restored, a tab
switched and a shell that exits all put the blocks back where they were and leave the content
alone. A block the reader has dragged is theirs, and the canvas does not run away from it.

`⧉` and `⇥` are what "separate" and "join" turned out to mean here, and the choice was between
that and split panes inside one block. A detached tab becomes an ordinary shape, so moving it,
resizing it and putting it where you want it are all things the canvas already does; a splitter
inside a block would have been a drag handle competing with the shape's own. The same reasoning
picks the buttons over dragging a tab from one strip to another: dragging would mean the strip
taking drag events across the width of the block, and the top of the card is the whole of what
still grabs the shape (below). "Nearest" is not a guess either — the choosing *is* the drag. Put the block beside
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

**The rect that one block comes back at is saved, per board** (#154). The size and the position
of the block are not the arrangement: they are what the reader dragged, and losing them was not
only a shape moving. A block put back at the default reports the default grid, the server
puts it at the live shell, and a full-screen program — `claude` included — repaints into a
smaller screen than it was left at, so *the sizes come back exactly as they were* was true of
the server and undone a moment later by the viewer that reconnected.

It lives in `localStorage`, under `excalidraw-terminal-geometry`, keyed by workspace id, and it
is written by `syncTerminalBlocks` — the one place that sees a finished resize — and read in the
last branch of `newTerminalBlock`. **Per board**, unlike the font size below: how big the
terminal is and where it sits is a fact about a project, while the size of the text is a fact
about the reader's eyes. **Not `customData`**, for the reason that section gives. The two doors
it covers are a reload and a switch of project and back, the second because the page clears its
per-session memory on the way into a board.

The rect is the reader's from then on, and nothing re-anchors it — including a rect remembered
from before #200 turned the canvas round, which is left where it is rather than migrated. That is
the same trade a restore after an erase already makes: re-anchoring is how a reload comes to undo
a drag, and the block is an ordinary shape the reader can move. Where it lands is no longer a
collision anybody has to live with either — the mirror re-measures around a block standing in it,
and the documentation steps aside from one standing in the region's way. A board that has never
had a block placed still gets the default grid at the anchored origin.

`scripts/check-terminal-geometry-browser.mjs` is the check: it drags a corner and a header with
a real pointer, reloads, and asks the *scene* for the rect and `GET /api/terminal` for the grid
the shell is holding — including that it never went down to the default and back up.

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

Left to right the canvas reads **mirror | terminals | documentation**. That is #200, and it
reverses #96: the block used to be the outermost region and the mirror the middle one. What
places each of them is one rule applied twice — `left - 120 - width` of the region it stands
beside, level with the top of it — and the reversal re-points one dependency in that chain
rather than changing the arithmetic:

| | placed from |
|---|---|
| the documentation | nothing; it is where the board authored it, and the only region with an author |
| the terminal blocks | the documentation, one gap left of it |
| the mirror | the terminal blocks, one gap left of them — or the documentation on a board that has none open |

So every region still follows a board that grew instead of sitting at a coordinate somebody once
picked, and each is measured from **one** neighbour rather than deriving the same number twice,
which is what keeps two of them from walking apart. A board with no `githubProject` draws no
mirror at all, and the terminal is unaffected: it was already measured from the content, so the
vacant slot is not a second rule, it is the same one with a region fewer on the canvas.

The blocks are still left out of the mirror's *content* measurement — they are handed to
`resolveMirrorOrigin` as a region of their own, and counted a second time as content they would
drag the answer a block-width further out. Since #99 that exclusion covers **a label bound to
either**, which is the rule the autosync and the export already stated.

**The mirror steps aside the first time a shell opens, and that is deliberate.** On a board with
a project and no block, the mirror is measured from the content and lands in the slot the first
block will take. When that block arrives the region is standing in it, so the mirror drops the
answer it remembered and measures again — once, on a collision, converging immediately because
what it settles on is a gap clear of the blocks. It is visible: the region moves a block's width
left, at the moment the reader opened a shell. That is the standard #99 set — a move with a cause
the reader can point at beats a drift they cannot — and the alternative was reserving a
block-shaped hole on every board that has the feature switched on and no shell in it.

Placed **once**, and since #99 the mirror is too. That used to be the difference between them:
this block is expected to be moved and resized, and a redraw that re-anchored it every twenty
seconds would undo that, while the mirror repainted on the timer and re-measured every time. The
re-measuring is what let the mirror drift away from the board on its own, so both regions now
resolve an origin the first time there is something to measure against and keep it.
`docs/project-board.md` has which edge the mirror pins and what that costs.

What still differs is what happens next. This block is the reader's to drag, and where it was
dragged is remembered and preferred over the rule above; the mirror has no such gesture, being
repainted from GitHub, so its origin only ever comes from the measurement.

**When the mirror moves, this block does not follow — so the mirror does not move.** That is the
decision #188 settled, and it is the only one of the two that keeps a dragged block where the
reader put it. The alternative was re-anchoring the block whenever the region's origin changed,
which means a shape the reader is expected to move being moved by a timer, and no way to tell a
block that has never been dragged from one dragged back to where it started. So the burden sits
on the region instead: it settles once per board and stays settled, and it is measured **from
this block**, one gap left of its left edge, which is one step of the chain above rather than a
second guess at the same number. That was `maxX + gap` until #200, the block being outside the
region then; the sign is the whole of the difference. Two regions, one separation, decided in one
direction only.
`docs/project-board.md` has the whole of that, and
`scripts/check-mirror-terminal-drift-browser.mjs` is what holds it: the two bounding boxes must
never intersect, across polls, a column appearing, and a board switched away from and back.

**Which side follows from that, and it is what #200 had to buy.** Placed once means the block
never moves aside, so it cannot sit on the edge the board grows into — and the documentation,
the only thing here that grew, grows down and right. That is why #96 moved the region behind the
mirror, and why putting it back in front of the documentation is not a one-line reversal: the
edge it now stands on is the edge that grows.

**So the documentation grows aside instead.** `documentationClearance` (in
`src/core/terminal-block.ts`) answers how far right the board's own content has to stand to
leave the region its room, and `commitTerminalLayout` moves it there on a split and back on a
merge. It is a **displacement**, not a position: the caller says where the documentation would
sit with no block open and the answer is added to that, so N splits and N merges leave the board
exactly where it started rather than a rounding away from it. It is measured against the
**region's** current extent rather than against the block that was just added, because a reader
may split more than two and each detach steps the next block a block-width and 40 further right.

**The shift is a real element move, and that is a decision with a price.** The documentation is
authored data — synced, exported, committed to `docs/board.excalidraw` — so opening a second
shell authors a board change, which `CLAUDE.md` treats as a commit like any other. Nothing else
in this project had ever moved authored content. It has to be real: only a real move survives the
reload the definition of done names, and a view offset would move the reader's camera rather than
the room the region needs. What keeps it from accumulating is the round trip above, and what
keeps a reload from applying it twice is that **how far the documentation has been pushed is
written down**, per board, in `localStorage` beside the block's own rect — a pushed board and a
board at rest are the same picture, since in both the leftmost block sits exactly one gap left of
the content, so geometry cannot tell them apart and a page that guessed would push again. The
move is synced immediately for the same reason: what the store holds and what that number says
have to be one answer. A browser that has never seen the board reads zero and treats what it can
see as where the content was authored, which is the safe direction — it pushes from there rather
than from a home it cannot know.

The board **sections** need no rule of their own. They are authored shapes drawn around halves of
the documentation, so they are part of the region that moves and they move with what they
contain; `Alt+P` and `Alt+G` land on them after a push because nothing about them changed except
their `x`. `scripts/check-canvas-order-browser.mjs` asserts both keys after a split.

**No exception to "placed once" any more.** A session opens on a `POST` that spawns a shell; the
mirror arrives on a poll that spawns a `gh`, so on a board that has a project the block is
essentially always placed before there is a mirror to see. That used to matter — the block was
anchored to the mirror, so it guessed, landed in the mirror's slot and had to be moved out of it
once by a `customData.awaitingMirror` mark (#124). Since #200 the block is placed from the
documentation, which is on the canvas before either, so the guess and the correction are both
gone. The collision is still real and it is now the **region's** to resolve, above.

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

**How big it is when it is first drawn** is `TERMINAL_GRID`, **125 columns by 30 rows**, and
since #199 that is the whole of the answer: the default is stated in the terminal's own unit and
the rectangle is derived from it at placement time, by `terminalSizeFor` against the cell the
browser measured. Only a *fresh* block reads it — a detach copies the block the tab came out of,
and a restore reuses the geometry the reader had — so nothing already on a board moves when it
changes.

It was a pair of scene units for three releases: 760 × 480, then 1140 × 720 in #144, "half again
in each direction" for a block that opened at about a hundred columns by twenty rows and could
not hold the agent transcript it exists for. What #144 could not do, and its comment did not
notice it had not done, was pin a *grid*. Half of a cell is a browser measurement rather than a
number in this repository — `terminalCell` takes the line box and the advance the page measured,
and since #115 the face is a web font, so the answer is not fixed even for the life of a page.
1140 × 720 therefore read as 147 columns against the fallback stack and 156 against Comic
Shanns, while the comment beside it claimed "around 150 × 33" for both; measured in a real
browser it was **154 × 29**. The rows were four out and nothing could see it, because an
arithmetic check that divides by the same assumed cell the code does agrees with it.

So the direction of the derivation is reversed. `terminalSizeFor` is `terminalGrid` read
backwards — the same terms in the same order, with the frame and the scrollbar strip added back
rather than divided out — and it rounds **up**, to whole scene units. That is the answer to
"exactly 125, or at least 125": a block exactly `cols × advance` wide is one floating-point
error from reporting one column fewer, and a unit of slack cannot buy an extra column when a
cell is ten of them. Two font stacks now get two different rectangles and the same screen, which
is the half of this a re-picked constant could not buy: 1282 × 1019 against Comic Shanns at the
default size, 1360 × 1034 against the fallback.

`TERMINAL_SIZE` is still exported and is still what `terminalOrigin` and `terminalBlockElement`
default to, but it is no longer a decision — it is `terminalSizeFor()` with nothing measured, the
rectangle the grid comes to for a caller that has no browser to ask. The frontend is not that
caller: it measures, and hands the answer to both.

**The size is derived at the size the reader is reading at**, not at the default one. The promise
is about the screen, so a reader who has pressed `+` to 24 still gets 125 × 30 — in a block half
again as big again. The other reading, a rectangle fixed at 18px text, would have given them
ninety columns and called it the default.

**The face has to have landed before the rectangle is worked out**, which is the one thing this
costs. Excalidraw registers the code face without loading it — see `terminalFontReady` — so a
block placed a beat early measures the fallback stack and lands seven columns wide of what was
asked for. `adoptTerminalSessions` therefore starts the load beside its first request and waits
for it before anything is placed. Nothing else waits on this: the grid a block *reports* is
re-measured every time it is reported, and there is a mount effect that reports it again once the
face arrives. It is the rectangle, placed once and then left alone, that cannot be revised.

One consequence, and it is the reason `reconcileTerminalBlocks` ends by redrawing the mirror. The
mirror is placed from this region, and `resolveMirrorOrigin` answers an empty anchor set with a
content-independent fallback it deliberately does not remember — so a block that appears *after*
the mirror's first draw leaves the region at that fallback until the next twenty-second poll,
which is the drift #188 is about seen from the other side. Waiting for the face made that
ordering the usual one rather than a race, so a block being added is now a reason to re-settle
the region.

### It stops where the canvas stops, and what it is allowed to cover

The overlay is drawn at the block's bounds converted to viewport coordinates, and there is no
clamp on that arithmetic on purpose: this card **is** the shape, so it pans and zooms with the
board and goes off the edge with it. The documentation card, which is a reading column pinned
*beside* a shape rather than the shape itself, is placed the other way round — `placeCard`
clamps it into the canvas area before it is drawn, so it can never leave. That asymmetry is
right, and it is also what left this card as the one overlay that could escape.

Until #153 nothing stopped it. Pan a block above the top of the canvas and `top` went negative;
the canvas wrapper declared no `overflow`, so the card was not clipped, and the project tab
strip and the `Excalidraw Canvas` header row are `static` and unpositioned, so a card carrying
any `z-index` at all painted over them. The screenshot behind #153 is a terminal's title band
and tab strip drawn across the chrome with the connection pill, `Sync to Backend` and
`Clear Canvas` underneath — and the card's body takes the pointer, so they were unclickable as
well as hidden. **The wrapper is `overflow: hidden` now**, so the card stops exactly where
Excalidraw already clips the rectangle under it, which is the half-visible block the reader
expects. Clipping rather than sliding it back on screen: sliding is what the documentation card
does, and doing it here would be the card coming loose from its block.

The layers are named once, on `.app` in `frontend/index.html`, rather than as a bare `5`
repeated in two stylesheets — `--board-z-overlay: 5` for the cards, `--board-z-chrome: 10` for
the tabs and the header, `--board-z-dialog: 50` for the dialogs over both. The chrome is given
a layer as well as the clip, because a single `overflow` declaration is a thin thing for
`Clear Canvas` to depend on.

**The overlays stay above Excalidraw's own layer UI** (`--zIndex-layerUI: 4`), which #153 asked
to have settled and which nothing in this repository had decided. Both readings are defensible:
the card stands for a shape, and a shape goes under the tool islands. It was settled the other
way because the documentation card shares the layer and is opened by *selecting* a shape —
which is exactly when Excalidraw's properties island is on screen beside it. Under the islands,
that panel's own buttons become the thing nobody can click, on every shape near the left edge,
and there is no gesture that gets them back. A terminal drawn over an island can be panned off
it; a panel drawn under one cannot be recovered at all.

## Paper, and the hand-drawn code face

Until #115 the block was dark — a Catppuccin Mocha surface on a `#1e1e2e` rectangle — and this
document said why twice: *a terminal that follows the canvas into light mode stops looking like
one*, and *the dark fill is what reads as a terminal at a zoom where the shape is all there is
to read*. Both were written about a board that has since changed. Every other region of this one
is a pale block with a hand-drawn label, and the terminal had become the single rectangle in
another design language. So it is **paper on a light board** now, in the same design as the
blocks around it — and, since #147, **its night side on a dark one**, which is the half of that
decision the section below is about.

**One palette per theme, in `src/core/terminal-palette.ts`.** Three different things draw this
block — the shape is an Excalidraw rectangle with a fill and a stroke, the emulator is xterm and
takes a theme object, the frame around it is a stylesheet — and each of them used to carry its
own hexes. A stylesheet cannot import TypeScript, so the way the three are held together is that
`TerminalPanel.tsx` writes `terminalCssVars(theme)` onto the card's own root and
`TerminalPanel.css` reads nothing but `var(--terminal-*)`. On the card rather than on `:root`,
so two terminal blocks are two independent surfaces and nothing leaks onto the canvas — and in
TypeScript rather than in an `[data-theme]` rule, because those custom properties arrive as
*inline styles* and a stylesheet rule cannot outrank one.

### Dark mode is a filter on the canvas, and the overlay is not on it

This is #147, and it is why the palette takes an argument. Excalidraw draws dark mode as
`.theme--dark canvas { filter: invert(93%) hue-rotate(180deg) }`. The block is on that canvas,
so its `#faf6ee` fill is painted near-black for free, like every other block's pastel is. The
overlay is a `div` and a *sibling* of Excalidraw, so nothing filters it: told nothing, it
painted a literal `#faf6ee` over a block the filter had already darkened, and the two things
`terminal-palette.ts` exists to keep identical were drawn eight stops apart. Only one of them
can be told what theme it is in, so it is told — `App.tsx` passes `theme` to `TerminalPanel`,
which is the same value it puts on `.app[data-theme]`.

**The shape's fill does not move, and that is what fixes the dark surface.** It is one literal
in both themes, for two reasons: it is scene data — synced, exported, committed — and the theme
is a per-reader setting in `localStorage`, so a fill that followed it would turn every toggle
into a change to the board and two readers with different themes into two boards; and a block
that opted out of the canvas filter would be the one shape on this board that did. So the dark
palette's surface is defined the other way round. It is the colour `#faf6ee` **comes out**,
`#1d1912`, measured off a real render rather than asserted — warm rather than Mocha's cool
`#1e1e2e`, which is the one place the dark palette departs from Catppuccin, and it departs
towards the paper it is the night side of.

**The emulator is re-themed, not rebuilt.** `terminal.options.theme` is assigned on the running
xterm. Disposing it and opening another would replay the transcript into a fresh parser, which
is the same picture only for a program that never used the alternate screen: a `vim` left open
in that tab would come back as its own scrollback. The check toggles the theme with a program on
the alternate screen and the emulator's DOM node marked, and asserts both survive.

**The face is `Comic Shanns`, and it is not shipped.** The blocks are lettered in Excalifont,
which is what the observation asked for, and an emulator cannot draw in it: xterm puts column N
at N × the cell width and Excalifont is proportional. What it can have is the monospaced member
of the same family — Excalidraw 0.18's picker offers exactly Excalifont (hand-drawn), Nunito
(normal) and Comic Shanns (code) — and Comic Shanns is metrically monospaced, every glyph 0.55 ×
the font size at every size. Excalidraw registers all of its faces on `document.fonts` whether
or not the scene uses them, so it resolves from the stylesheet with no `@font-face` of ours and
nothing to preload. What Excalidraw does **not** do is load them: all four faces are registered
and none of them is fetched until something asks to draw with it, which is what
`terminalFontReady()` in `frontend/src/terminal-metrics.ts` is for. Two things depend on that
having happened, and both are in *Where a cell comes from* below.

**All twenty-one theme entries are set, in both palettes.** The old theme set five and let the
other sixteen fall through to xterm's own, which are tuned for a dark background: on paper its
yellow came out at 2.3:1, its bright white at 1.1:1 — not a colour anyone chose, the colour
nobody set. The sixteen are Catppuccin hues moved until each one clears **3:1** against its own
theme's surface — **Latte** darkened for paper, **Mocha** lifted for night — which
`check-terminal-paper-browser.mjs` asserts of a real render, in both themes, rather than of the
module. Neither palette survives as shipped: on paper Latte's yellow is 2.4:1 and its `surface2`
2.0:1; on night Mocha's own `black` `#45475a` is 1.8:1.

The greys are the awkward part and no terminal theme escapes it, in either direction. On a dark
background the ramp runs black → bright white from least ink to most; on paper "white" is the
colour of the page, so a program asking for white text is asking for nothing, and on night
"black" is the colour of the card. The **white end** of the ramp is therefore read as
**contrast** rather than as lightness in both: `brightBlack` is the dim one every tool uses for
comments, `brightWhite` is the strongest mark, and "bright" means *further from the surface*
rather than lighter. The cost is that `white` and `brightBlack` end up two similar greys on
paper, so a program that distinguishes those two will not be distinguished here.

**The black end is not turned round, and #159 is what turning it round cost.** On paper `black`
is a near-black — Mocha's `crust` — because that is what the word means and because it is the
one slot a program reaches for when it draws *on* a colour. It used to be `#5c5f77`, a mid grey
picked for symmetry with `white`, and that symmetry is the section below.

### A slot is ink, and a slot is also a page

This is #159. The floor above asks each of the sixteen to be legible **on the surface**; a
program that draws a chip asks something else of them, and until now nothing checked it. Claude
Code — the program this block exists to run — draws its hint as ANSI `black` on ANSI
`brightCyan`, which was **1.11:1** on paper and 2.15:1 on night: the illegible steel-blue strip
in #147's screenshot, worse in light mode than in dark, and there since #115.

**The contract.** A pair drawn from within the sixteen clears the same **3:1** the ink does.
Which pairs are in reach is arithmetic rather than taste, and it comes out differently in the
two themes because the ink floor pushes `black` in opposite directions:

- **`black` is the ink, and it is the end of the ramp.** On paper the darkest of the sixteen; on
  night the slot *closest to the surface* that still clears the ink floor, since a `black` below
  that floor fails the other check.
- **On paper that is nearly free.** `black` can go all the way out, so fourteen of the other
  fifteen are pages under it, the worst at 3.3:1. Only `brightWhite` is not, and cannot be: on
  paper it is the strongest grey ink, and `black` on it is ink on ink.
- **On night the floor holds `black` up** at 3.3:1 against the surface, so a page has to be
  about **ten times** the surface to clear 3:1 over it. That is the light half of Mocha:
  `yellow`, `green`, `cyan` and `magenta` in both their members, plus `brightWhite`. `red`,
  `blue`, `white`, `brightRed`, `brightBlue` and `brightBlack` are **out of reach**, and the
  reason is the hue: a red or a blue lifted to a 10:1 ink is a pink or a powder blue, which is
  no longer that colour, and the comment grey is near `black` by trade.
- **`brightWhite` is the other ink, on night only**, where it clears `black` and `brightBlack`.
  On paper there is no light ink at all and there cannot be — every one of the sixteen is 3:1
  ink on a light page, so every one of them is dark. **A program that draws light-on-colour
  cannot be served on paper by any palette that keeps the ink floor.** That is a cost of the
  floor rather than an oversight, and it is written here rather than hidden.

**What moved.** `black` on paper, from `#5c5f77` to `#11111b`; `black` on night, from `#7f849c`
to `#666a81`, which is as near the floor as ink gets and therefore as much of the palette in
reach as there is. And the six chromatic pairs on night are **swapped** — not one new hex —
because they were the wrong way round: `brightCyan` was `#6bd7ca` against a `cyan` of `#94e2d5`,
the light palette's rule applied to a surface it is backwards on. Emphasis read as less
emphasis, and the dimmer member of each pair was exactly the one a program picks for a chip's
page, which is how the worst pair on this card came to be `bgCyanBright`.

`scripts/check-terminal-pairs-browser.mjs` prints all sixteen as pages from a real shell, reads
both colours back off the render in both themes, and asserts the lists above **exactly** — a
slot that quietly comes into reach fails it too, because the same lists are in
`terminal-palette.ts` and a list that is true in one place only is what this file has paid for
before.

**`COLORFGBG` is still not set**, and #159 asked again whether it should be. It should not. It
names the terminal's background so a program can pick against it, the shell is spawned once, and
the surface now follows a theme the reader toggles — so the value would be right until the first
`Alt`-less click on Excalidraw's menu and wrong for the rest of the session, with nothing to
re-send it and nothing that re-reads it. The two answers it would have to hold are also no
longer the question they were: the palette is legible in both themes now, as ink and as page,
which is what a program consulting `COLORFGBG` was going to be told anyway.

**What says "terminal" when the text has gone.** That was the dark fill's other job, and paper
cannot do it — at a zoom where the overlay's text is four pixels tall there is nothing to read
but the shape, and a pale rectangle on a board of pale rectangles is one more block. So the
identity moves from the fill to a **band**: the header is a solid strip of the strongest colour
on the card, across the top of it. A band is an area rather than a glyph, so it survives being
shrunk; the check asserts it at zoom 0.15, where the card's text is under five pixels and none
of it can be read.

There were two, top and bottom, until #144 removed the strip along the bottom. The claim that
survives is the one that was ever load bearing — that *a* band crosses the block at a zoom
where nothing can be read — and the header is the band that also has a second job, since #112
made it the whole of what selects and drags the shape. A second one, kept only to be looked at,
was paying for symmetry with a row of the reader's screen.

The band **inverts with the theme rather than staying dark**, which is the part #147 could have
got wrong. It is the ink colour in both palettes, so on night it is a light strip on a dark
card — and it has to be: the board behind it is dark too, so a dark band on a dark card at zoom
0.15 is a block with nothing on it, which is exactly the failure the band was invented to
prevent. The check asserts 3:1 against whichever surface it is on.

Four things the issues left open, decided here:

- **Paper on paper, night on night.** #115 decided paper in *both* themes, on the reasoning that
  following the canvas would mean two palettes to keep legible instead of one. #147 reversed it,
  and not on taste: the canvas theme is a filter and the overlay is not on the canvas, so
  "one palette" was never on offer — it was one palette *declared* and two *painted*. Two, kept
  legible, and checked in both.
- **The shape stays one literal.** See above: scene data cannot depend on the reader's theme
  without every toggle becoming a change to the board.
- **One look, not a choice for the reader.** The font size became a header control in #103
  because a grid the shell is told is a real constraint on a real block. A colour scheme is not
  that, and a preference nobody asked for is a preference that has to be kept working. The
  canvas theme is not that preference — it is the board's, and this follows it.
- **Programs that assume a dark terminal are told nothing, and are served anyway.** `COLORFGBG`
  is still not set, so `vim` — and Claude Code, which this surface was built for — pick
  foregrounds and pairs against a background nobody named for them. #159 asked whether to set it
  and decided not to, for the reason given above: the shell is spawned once, the surface follows
  a theme the reader toggles, and a variable that goes stale on the toggle with nothing to
  re-send it is worse than none. What is done instead is to make the palette right for whatever
  the program picks — as ink *and* as page, in both themes — which is the section above.

## The font size is an input to the grid

The reader sets it, with `−` and `+` on the block's own header, between 8 and 24, and it starts
at **18** — `TERMINAL_FONT_SIZE`, which #199 moved up from 13 along with the default grid the two
numbers were asked for together. What the zoom multiplies is that size, so the two questions stay
separate: the zoom is how close the board is, and this is how big the text is on it.

**That is not the size the constants in `terminal-block.ts` were measured at**, and since #199
the two are named separately. `TERMINAL_METRICS_FONT_SIZE` is 13, because `TERMINAL_CHROME.height`
is 64 from a render at 13 and `TERMINAL_CELL.width` is 7.6 from the fallback stack's advance at
13; `scaleOf` divides by *that* to carry them anywhere else. Pointing it at the reader's new
default instead would have re-read every one of those measurements as though it had been taken at
18 — a frame reported 27% smaller than the one on screen, which is #104's defect exactly. The
reader's size moves when somebody asks; the measured one moves when somebody measures.

It could not be a display tweak. xterm sizes its canvas as `cols` × `rows` × the font, and the
grid is derived from a cell measured at whatever size the text is at — so a `+` that only assigned
`terminal.options.fontSize` would leave the emulator drawing past the frame, and everything past
the frame is clipped rather than scrolled *sideways* (below). Bigger text, silently fewer visible
columns, and no way to reach them — the bar the block grew in #197 scrolls the scrollback, which
is the only axis an emulator has.

So `terminalGrid()` takes the font size as its second argument, and one size feeds four things:
the cell, the frame — the header, the tab strip and the padding are all `em`, so the chrome
grows with the text it holds — the scrollbar's strip, which is `em` for the same reason, and
therefore the grid. **A larger font in the same block is
fewer columns and fewer rows**, reported down the same debounced route a corner drag uses. The
`cols`×`rows` in the header is the confirmation, because it is what came back from the shell.

Two decisions the observation left open:

- **It survives a reload**, in `localStorage` next to the theme, and it is **global rather than
  per board**: it is a preference about the reader's eyes, and the same eyes read every project.
- **It never reaches `customData`.** The block is derived and stripped at both doors, so a size
  stored on the shape would be dropped on the way to the store and read as the block forgetting
  it.

Buttons rather than a shortcut, for a reason beyond discoverability: while the terminal has the
keyboard a keystroke is the shell's unless something has claimed it by name, so `Ctrl+-` would
reach the shell and not the block. #177 claimed four keys that way and no more — a fifth would
be one more Readline motion spent, and the font has buttons.

## Where a cell comes from

**Both halves are measured, in the browser, every time the grid is worked out**, and the two
got there by different routes: the row in #104, the column in #115.

The **width** was a constant for as long as there was one typeface, and #104 said so: the stack
advanced 0.586px per font pixel at every size in the range, against the 0.585
`TERMINAL_CELL.width` was drawn with. What ended that was the typeface changing. Comic Shanns
advances **0.55**, five per cent narrower, which is seven columns of a default block — and a
column constant carried across a face change is the same defect as the row one, in the other
direction. A cell measured against one typeface says nothing about another, and the face is now
a *web font*, so "the font this page resolved" is not even fixed for the life of the page.

So the advance is measured too, and xterm does no arithmetic on it at all: `device.cell.width`
**is** the measured advance and `css.cell.width` divides it straight back out, so unlike the row
what is passed in is the number rather than an input to a formula. The direction of the error
matters and decides the fallback: too narrow a cell reports more columns than the frame can
draw, and the overshoot is clipped rather than scrolled; too wide only costs a column. So
`TERMINAL_CELL.width` stays at the **widest** face the stack can resolve to.

Two things follow from the face being loaded rather than present:

- **xterm measures its cell at `open()`**, and a face that has not arrived is measured as the
  fallback and kept for good. Opening later would mean no emulator while the transcript is
  arriving, so the measurement is redone instead: `terminalFontReady()` resolves, and the
  emulator is asked to re-measure by setting `fontFamily` to the fallback and then back. Two
  writes, because xterm's options service fires only on a value that *changed* — setting it to
  what it already is does nothing at all.
- **A block placed before the face lands reported the fallback's grid**, and nothing would have
  corrected it: the error is always in the safe direction, so it is a narrower terminal rather
  than a clipped one, and no assertion anywhere would go red. `App.tsx` re-reports every block's
  grid once the face is in. A block placed after that has measured the real face already,
  because the measurement asks the browser every time rather than remembering.

The **height** could not be a constant either, and the one it had was wrong.
`TERMINAL_LINE_HEIGHT` was `1.35` and read as *"a row is 1.35 × the font"* — but that is the
`lineHeight` xterm is **given**, and xterm never applies
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
`1.75`, rounded **up** from the tallest face the stack can resolve to, because too tall costs
the reader a row at the bottom and too short costs them rows they cannot reach at all.

**`TERMINAL_LINE_HEIGHT` is `1` since #115**, and that is the same measurement arriving in the
other place. `1.35` was comfortable over the Cascadia stack's line box of a little over `1em`.
Comic Shanns' box is `1.72 ×` the font size, so the same multiplier would have made a row
`2.3 ×` the font and spent seven of the default block's twenty rows on leading nobody asked for.
The face brings its own space, so this stops adding any — and `1` is also the smallest value
xterm will accept, which is the one point where the arithmetic here and the emulator's own
validation meet.

The font family and the line height live in `terminal-block.ts` for the same reason the
measurement does: the emulator is opened with both of them, so a grid derived from one font and
drawn in another would be two fonts agreeing on a number.

**Resizing is Excalidraw's own.** The block is a real scene element, so dragging a corner
resizes it and selecting it opens the usual style panel. The reader's new size reaches the
server as `cols` × `rows`, derived from the block's **scene** size so that a pinch is not a
resize, and debounced so a drag is one request rather than one per frame.

That is the collision an emulator brings, and #112 is where it was resolved the other way
round from how it started. **The screen takes the pointer; the header is what still reaches
the shape.** For three revisions the whole overlay was transparent and one strip along the
bottom was carved back out of it, saying `click here to type`, on the reasoning that an
overlay taking clicks would take the block's resize handles with it. That reasoning was
measured and found wrong: Excalidraw's handles sit two to ten screen pixels *outside* an
element's bounds and the overlay covers exactly the bounds, so the screen can take every
click it likes and the block keeps every handle.

What a pointer-taking screen really costs is selecting and dragging the block from its
middle, and the header buys that back. Click the header to select the block, drag it to move
the block; the handles that appear then are the shape's own, so the header is load bearing
for resizing too — a handle only exists while something is selected. It has a **minimum
height in screen pixels** for that reason: everything on this overlay is sized in `em` and
follows the zoom, which left the only draggable band about five pixels tall on a zoomed-out
board. The minimum is a no-op above about 70% zoom, and it does not change what any shell is
told, because the grid comes from the block's scene size rather than from the frame on screen.

Below the header the pointer is the shell's. A click focuses the emulator; a drag selects
text; **Ctrl+C copies while something is selected and interrupts the rest of the time**, the
way this machine's own terminal settles it, dropping the selection so the next press is an
interrupt again; **Ctrl+V pastes what the clipboard is offering** — text into the shell, and
a screenshot as the `\x16` that lets the program go and fetch it, which is the rule
[below](#a-paste-is-decided-by-what-the-clipboard-is-offering); the wheel scrolls the
scrollback, and so does the bar along the right of the screen; and Alt+click moves the shell's
cursor along the line it is editing. A wheel the scrollback cannot use — the screen is at the
bottom, or there is none — is handed to the canvas instead of dropped, so panning and zooming
still work over a block.

**The wheel is answered one axis at a time**, which is #162 and what a touchpad made
visible. A pan carries both deltas in the same event, and the emulator has a use for exactly
one of them: xterm has no horizontal scrolling and emits no escape sequence for a sideways
wheel, so `preventDefault` on the four pixels of scrollback it did want was taking the
hundred and twenty pixels of pan it had no use for with it. **The horizontal delta is the
board's** — while the scrollback still has room, and while a program is holding the
pointer — and only the vertical one is offered to the emulator first. Ctrl, Meta and Shift
stay whole: those are the zoom gesture and Excalidraw's own sideways wheel, and each reads
the two axes together, so splitting one would be two gestures where the reader made one.

**Unless the gesture was going up**, which is #198 and the word `always` coming out of the
sentence above. #162 was written against a mouse wheel and a diagonal the reader meant, where
every `deltaX` is one they asked for. A finger on a trackpad is never exactly vertical: read a
scrollback and each event of the pan carries a few pixels of sideways drift whose sign follows
the tremor of the hand, and a rule that forwards each of them on its own, sixty to a hundred
and twenty times a second, is a board swinging left and right for as long as the reading goes
on. So **the axis is decided once per gesture and then held**: the first event carrying real
movement is measured, and a gesture whose sideways is under a quarter of its vertical drops its
horizontal half for the rest of the gesture instead of forwarding it.

A **ratio** rather than a dominance test, and the difference is the exactly-45° pan: `|deltaX|
> |deltaY|` refuses it, and a diagonal drawn at exactly 45° is one the reader plainly meant.
Drift sits around `3/120` and a deliberate diagonal at `1.0`, an order of magnitude apart, so
the threshold has a wide bracket to sit in and 0.25 is a choice inside it rather than a
measurement. The gesture ends after **180 ms** with no wheel: the DOM has no `wheelend` to pair
with `wheel` the way `pointerup` pairs with `pointerdown`, so a gap is the only terminator
there is, and one that long is the finger off the glass at any sampling rate a trackpad uses.
Both numbers are tuned against synthetic events, and neither is derivable from this repository.

The lock is **not symmetric**, deliberately: a sideways pan carrying incidental vertical still
gives that vertical to the emulator. The two directions are not mirror images of each other,
because the horizontal half is only ever the board's camera while the vertical half is the
emulator's first — dropping incidental vertical here would not stop the scrollback creeping
anyway, since xterm has already seen the event by the time this handler could refuse it, and it
would take the wheel away from a program holding the pointer to buy nothing. Only the vertical
case was reported; a mirror is a second decision and wants its own evidence.

Every keystroke
otherwise goes to the shell, Ctrl+C and arrows and Escape included, and none reach Excalidraw,
which binds every bare letter to a tool. The four exceptions are the board's own keys — Alt+B,
Alt+T, Alt+P and Alt+G, which navigate the canvas from inside a focused terminal and are not
sent to the shell; see [the hotkey](#the-hotkey) below. Clicking the canvas blurs the terminal
and gives the keyboard back, and since #177 nothing needs it to.

**The strip along the bottom is gone**, which is #144 and the other side of the argument #112
settled. #112 kept it as a status line, on the grounds that a band which reads like a prompt
and does nothing is worse than either answer. What it then said was `click the screen to type`
and `typing goes to the shell` — two sentences narrating where the pointer already was, to a
reader who has to have clicked the block to be reading them. Its third state is not narration:
a shell that has gone leaves a block with no way back written down anywhere on screen. So that
one is kept, and re-homed **over the screen** rather than in a row of its own. A row is chrome,
and chrome is what `terminalGrid()` subtracts, so a band that appeared when a shell exited
would re-grid the block at the moment its shell died; drawn over the transcript it is free, and
it takes no pointer events, so the click underneath it still belongs to the screen.

The tab chips take the pointer rather than the row they sit in, and the font buttons stay as
small as a target can be, for the reason that survived, inverted: the top of the card is the
whole of what selects and drags the block. What #144 changed is the **size** of a chip rather
than which part of the row takes the pointer — the strip is drawn at `--terminal-tab-scale`,
half again as big, so the chips, their close marks and `+`, `⧉` and `⇥` are all easier to hit,
while the row around them stays transparent and the header above them stays exactly the size it
was. The budget #112 was defending is that header band, and the strip is not it; the trade is
that the tab row is now taller than the header over it, which is what the observation asked
for. One variable does the whole row, because every length in it is `em` off the row's own
font-size — the one exception, the chip's 1px outline, is drawn as an inset shadow instead of a
border, since a browser snaps a border to whole device pixels and a chip that grew by
`1.5 × em + 2px` measures 1.446× rather than 1.5×.

`scripts/check-terminal-focus-browser.mjs` is the check for who owns the pointer — it clicks
the middle of the screen and types, drags the header and the body and compares what moved,
turns the wheel both ways and sideways, and drags a corner afterwards to say the shape is
still a shape.
`scripts/check-terminal-size-browser.mjs` is the check for the sizes, and it measures the
render rather than the file: it reads the block the board placed off the scene, measures each
control against itself with `--terminal-tab-scale` forced back to 1, and asks for the bottom
bar's absence twice, live and with the shell gone.

## The scrollbar is a term of the grid

The block scrolled from the day it had an emulator, and for a long time nothing said so. The
wheel moved the scrollback; there was no thumb, so a reader could not tell a block had a
transcript behind it, could not see where in it they were, and could not drag to a point in it.
`TerminalPanel.css` said `overflow: hidden` on xterm's viewport and explained itself: a real bar
is a strip of the block's width, `terminalGrid()` knew of no such strip, and everything the
frame cannot hold is clipped rather than laid out — so the bar would have been drawn over the
last column the shell was told it had. That was not a shortcut. It was the same coupling #104
and #115 are monuments to, and #197 is the number it was blocked on.

`TERMINAL_SCROLLBAR` is **12**, and it is a decision rather than a measurement. A native bar is
15–17px on Windows and a zero-width overlay on macOS — xterm's own `Viewport` measures it and
falls back to `|| 15` for exactly that reason — so a strip whose width came from the reader's
operating system would be a grid that differed per machine for a board two people are looking
at. The bar is therefore **styled to that number** rather than left at the platform's, and the
number is subtracted in `terminalGrid()`: `cols` comes from `width − chrome − scrollbar`. It
scales with the font the way the chrome does, because everything on this card is `em`, and it is
subtracted **whether or not there is anything to scroll** — a strip that appeared with the first
screenful would re-grid the block, and repaint every full-screen program in it, at the moment
its shell printed enough to fill the screen.

Two numbers that must not drift, so there is one: `TerminalPanel.tsx` writes
`terminalScrollbar(fontSize)` onto the card as `--terminal-scrollbar`, in the pixels the current
zoom draws it at, and the stylesheet's `::-webkit-scrollbar` reads nothing else. A stylesheet
cannot import TypeScript; a width spelled twice is the last column under the bar.

The bar is **native, not a thumb of our own**. The drag, the click in the track, the keyboard and
the momentum are all the browser's, and xterm's `Viewport` turns this box's `scrollTop` back into
buffer lines however it moved — so a bar is a **viewer** and never an input to the shell. The
check asserts that in the strongest form available: the server's own `scrollback` is
byte-identical across a drag, and the shell is told no new grid.

Three answers this took that the observation did not settle:

- **It reaches the emulator's buffer, not the server's.** The server keeps `SCROLLBACK_LIMIT`
  bytes per session and the emulator is built with xterm's default of 1000 lines, so the thumb
  spans the last thousand lines rather than the whole transcript the server holds. Raising the
  client buffer is a separate question about memory per block, and it is not this one.
- **It does not fade.** Present whenever there is scrollback and absent when there is not —
  `overflow-y: auto` — because a bar that hides is a bar the reader has to discover twice.
- **Firefox gets `scrollbar-width: thin` and chooses its own width**, so it may be a pixel or
  two off the strip the grid reserved. It is behind `@supports not selector(::-webkit-scrollbar)`
  and it has to be: in Chromium any `scrollbar-width` other than `auto` makes the
  `::-webkit-scrollbar` rules ignored, so declaring it unconditionally would take the exact strip
  away on the browser that can draw one.

**A horizontal bar cannot be built this way and is not there.** xterm has no horizontal scrolling
and emits nothing for a sideways wheel, so a line too wide for the block is clipped; the answer
to that is the block's own resize handles, or `−` on its header.

## The hotkey

**Alt+T** brings the terminal into view, alongside **Alt+B** for the mirror. `Alt` for the
reason that one gives: Excalidraw owns the bare letters and much of `Ctrl+Shift`. It is matched
on `event.code` and bound on `window`, so it survives a keyboard layout where Alt produces a
different character and works from anywhere on the page. It stands down while text is being
edited — a card's title, a search field, Excalidraw's own label editor — **but no longer while
the terminal has the keyboard**, which is #177 and the reversal below.

### The four keys are the board's, even over a focused shell

For three releases the four board keys — `Alt+B`, `Alt+T`, and `Alt+P` and `Alt+G` for the
sections ([board-sections.md](board-sections.md)) — did nothing at all while the terminal had
the keyboard, and this document said so on purpose: `Alt+T` "has to be a keystroke the shell
receives rather than a jump", and the way back was to click the canvas first. #177 is the
reader saying that is the wrong trade. A block that owns the keyboard is a hole in the board's
own navigation, which is the same complaint #112 settled for the wheel — and the answer is the
same one: what the block cannot use, the board gets.

**And the shell is not sent them either.** That is the maintainer's own word on the issue, and
it is what makes this a change rather than half of one: `Alt+B` reaching xterm is an `ESC b`
written to the shell, so a board that only jumped would jump *and* leave a meta escape on the
reader's command line.

Three layers had to agree, and each was a real stop — `frontend/src/board-hotkeys.ts` holds the
rule the first of them reads:

1. **The guard on the four `window` listeners** stood down for any focused `TEXTAREA`, and a
   focused xterm **is** one: the emulator takes the keyboard through a hidden helper it marks
   `xterm-helper-textarea`. The guard did exactly what it was written to do; it simply could
   not tell "a card's title is being typed into" from "the terminal has the keyboard". It now
   asks what the focused node *is*, and every other `TEXTAREA`, `INPUT`, `contentEditable` and
   Excalidraw `editingTextElement` stands the keys down exactly as before.
2. **The card stops `keydown` propagating**, so Excalidraw does not read a shell's keystrokes
   as its tools. React's `stopPropagation` calls the native one and React listens at its own
   root — *below* `window` — so a chord stopped there never reached the listeners at all. The
   issue did not name this layer, and it is why fixing only the guard changes nothing a reader
   can see. The card now lets exactly these four past; what goes by is an `Alt` chord, which is
   not one of the bare letters Excalidraw binds.
3. **xterm's `attachCustomKeyEventHandler`** returns `false` for exactly these four, which is
   what stops the meta escape *without* calling `preventDefault` — so the event goes on
   bubbling to `window`. Every other `Alt` key is still the shell's, AltGr included: it arrives
   as `Ctrl+Alt` and is somebody typing a `@`.

**What the shell gives up** is four Readline word motions — `Alt+B` is `backward-word`, `Alt+T`
`transpose-words`, `Alt+P` `non-incremental-reverse-search-history`. This project's default
shell on Windows is PowerShell with PSReadLine, whose keymap differs, and nothing here offers
an escape hatch to send the four anyway; nobody has asked for one. Everything else is
untouched, and deliberately: `Ctrl+C`, `Ctrl+V`, bare arrows, Escape, `Alt+click` and every
bare letter stay the shell's. The *modified* arrows and `Backspace` are the block's own since
#186, and they are the shell's all the same — see [the editing chords](#the-editing-chords-are-sent-as-measured-bytes)
below, where what the block claims it claims in order to send better bytes rather than to keep
them.

`scripts/check-terminal-hotkey-browser.mjs` is the check, and it asks in a real Chrome what
only a browser can answer: each of the four moves the viewport — read off `scrollX`/`scrollY`
rather than off a handler having run — while the server's own `scrollback` stays byte-identical
and the page sends the shell nothing at all; a command typed straight afterwards still runs, so
the emulator kept the keyboard; `Ctrl+C` still interrupts and `Alt+click` still reaches the
shell; and `Alt+P` typed into a card's bound label is still a keystroke rather than a jump,
which is the case the guard exists for.

It does more than Alt+B, because the terminal has four ways of being absent and this is the one
answer to all of them: it scrolls to the blocks, places one if the board has none, and **opens a
session if none is running** — which covers a shell that exited, a board whose own attempt to
open one failed, and the last tab having been closed with its block. That last part is what
makes it a way back rather than a jump: the key used to stand down whenever no session was open,
which is to say in exactly the cases a reader reaches for it.

The key is on the block as well as in here. When a shell has gone, a notice across the bottom
of its screen says so and says how to get another — `+` for a tab beside it, or this key —
because a key written down only in markdown is a key nobody finds, which is the half of #93
that was never about the eraser. It was a permanent strip below the screen until #144; what it
is now is a band drawn *over* the transcript, only while a shell has gone, so it costs the grid
nothing and appears where the reader is already looking.

### The editing chords are sent as measured bytes

`Ctrl+Backspace` deleted one character rather than a word, and on a Mac `Cmd+Left` and
`Cmd+Right` did nothing at all. #186 is that observation, and neither half was a bug anybody
here had written: both were xterm.js defaults nobody had ever looked at. The key map claimed
the four board keys, `Ctrl+C` and `Ctrl+V`, and handed the rest over.

What xterm hands over is not always a chord a line editor answers:

- `Ctrl+Backspace` was `\b`, which is also `Ctrl+H`, which readline reads as
  `backward-delete-char` — one character, with nothing in the byte to tell the two apart, which
  is why `~/.inputrc` cannot fix it either (xtermjs/xterm.js#486). On Windows it looked correct
  because **ConPTY rewrites an incoming `0x08` into a `VK_BACK + LEFT_CTRL` key event**
  (microsoft/terminal#3935, in conhost since build 19603), which is what fires PSReadLine's
  `BackwardKillWord`. No such rewrite reaches `bash`, so this only ever broke there.
- `Cmd+Left` and `Cmd+Right` were dropped on the floor — `if (ev.metaKey) break;` — and
  `Cmd+Backspace` sent one `DEL`, because that branch never consults `metaKey`. xterm closes
  these as the embedder's business (xtermjs/xterm.js#597).

So the block claims them, in `frontend/src/terminal-keys.ts`, and it claims **all** of them
rather than only the broken ones: xterm has already removed its own alt-to-word hack for 6.0
(xtermjs/xterm.js#4538), telling embedders to own this, and a table that is ours does not
change under an upgrade. The table is read before the AltGr bail, which returns early for every
`altKey` chord and would otherwise leave a macOS `Option` entry unreachable.

**Every sequence in it was measured against both line editors** — PSReadLine over ConPTY and
readline in `bash` — because the two disagree in ways no amount of reading settles:

| chord | sent | why not the obvious alternative |
|---|---|---|
| `Ctrl+Left` / `Ctrl+Right` | `ESC[1;5D` / `ESC[1;5C` | already what xterm sent, and both editors answer it. `ESC b`/`ESC f` print a literal `b`/`f` under ConPTY |
| `Ctrl+Backspace` | `^W` | `\b` is one character on readline; `ESC DEL` prints a literal `^H` under ConPTY |
| `Ctrl+Delete` | `ESC[3;5~` | `ESC d` works in both too, but this sequence *is* `Ctrl+Delete`, so it stays true to a reader who looks it up |
| `Option+Left` / `Right` | `ESC b` / `ESC f` | macOS only, and byte-for-byte what xterm's hack sent — taken over rather than changed, so 6.0 cannot remove it |
| `Option+Backspace` | `ESC DEL` | macOS only, and again xterm's own answer, which is right in front of readline and ZLE |
| `Option+Delete` | `ESC d` | macOS only. xterm sent `ESC[3;3~`, which neither editor binds |
| `Cmd+Left` / `Cmd+Right` | `ESC[H` / `ESC[F` | `^A` is `SelectAll` in PSReadLine and `^E` prints as `^E`; both editors answer these |
| `Cmd+Backspace` | `^U` on a Mac, `ESC[1;5H` off one | the one row with no single answer — see below |
| `Shift+Enter` | `ESC CR` | a line break rather than a submit. The two encodings that say it exactly, `ESC[13;2u` and `ESC[27;2;13~`, have to be asked for first — see below |

`Cmd+Backspace` is "delete to the start of the line", and no sequence does it in both: `^U` is
readline's `unix-line-discard` and ZLE's `kill-whole-line`, and PSReadLine has no binding for it
and prints `^U` into the line it was meant to clear; `ESC[1;5H` is `Ctrl+Home`, which is
PSReadLine's `BackwardDeleteLine` and which readline ignores in silence. So the keyboard
decides, and the keyboard is the best proxy available for the line editor — this board is
served over loopback, so the browser is nearly always on the machine the shell is on.

`^W` costs one thing worth writing down. readline's `unix-word-rubout` is delimited by
whitespace and PSReadLine's `BackwardKillWord` by a punctuation set, so `foo/bar-baz` goes in
one press under `bash` and three under PowerShell. The alternative was a sequence that works in
one shell and types `^H` into the reader's command line in the other, which is not a choice.

Three shapes are turned down before the table is consulted at all. **`Shift` on anything but
`Enter`** — the rule was "anything with `Shift`" until #238, for a reason about *selection-growing*
chords: `Shift+Ctrl+Left` grows a selection in a text box and a shell has none, so xterm's
`ESC[1;6D` is the honest answer and stays. `Shift+Enter` grows no selection and was never what that
reason was about, so the reason keeps its rule and the one chord it does not cover comes out from
under it. Anything with more than one of `Ctrl`, `Alt` and `Meta`, because `Ctrl+Alt` is how AltGr
arrives on several layouts and that is somebody typing a `@` — `Shift+Enter` carries *none* of the
three, so that count refused it as well and it is asked before the count is taken. And `Alt` off a
Mac, because there it is a third-level shift rather than `Option`, and xterm's own `Alt+Left` is
already the word motion the table would send — claiming it would be taking a key for no change.

### Shift+Enter is a line break, and at a prompt it is nothing

`Enter` submits, and so did `Shift+Enter`: xterm's `case 13` reads only `altKey`, so both were the
same bare `CR` and every program behind the block read them as one keystroke. #238 is a reader
asking for a line break and getting a submit — the same shape as #186, an xterm.js default nobody
had looked at, and underneath it something older still. Legacy terminal encoding has no room for a
modifier on `Enter` at all; microsoft/terminal#530 is the same defect one layer down, in Windows
Terminal. Which is why Claude Code's own documentation lists `Shift+Enter` as working per emulator
rather than universally.

**`Alt+Enter` has been sending `ESC CR` all along**, out of that same xterm branch — undocumented
here until now, under a chord nobody reaches for. It still does, and it is byte for byte what
`Shift+Enter` now sends.

`ESC CR` rather than either extended-key encoding, and that is the whole of the choice. `ESC[13;2u`
(CSI u) and `ESC[27;2;13~` (xterm's `modifyOtherKeys`) say `Shift+Enter` exactly, where a legacy
byte cannot — but a program that has not asked for the protocol prints them as literal characters,
and xterm.js exposes no way to know whether it has: ghostty-org/ghostty#7780 is exactly that,
Claude Code with `[27;2;13~` drawn across the screen. `ESC CR` needs no negotiation of any kind,
and it is what Claude Code's `/terminal-setup` writes into VS Code, Cursor, Alacritty and Zed —
Claude Code being the program this block exists to run.

**And it is not a line break at a bare prompt, in either line editor.** Measured rather than
reasoned about, the way every other row here was:

- **PSReadLine over ConPTY does nothing whatsoever with it.** A half-written line is repainted
  unchanged; a bare prompt answers with not one byte. Nothing is inserted, nothing is run, nothing
  is cleared. PSReadLine does bind `Shift+Enter` — to `AddLine`, which is the line break being
  asked for — but ConPTY has no plain byte that carries the `Shift`, so nothing reaches it.
- **readline in `bash` rings the bell and leaves the line alone.** `ESC CR` is `meta-CR`, which
  readline leaves unbound, and an unbound sequence is a `BEL` and no more. Again nothing inserted,
  run or cleared.

So `Shift+Enter` at a prompt does nothing, where it used to submit whatever was on the line. That
is the trade, and it is a plain improvement rather than a wash: the chord is for the program
running *in* the shell, and there is no editor it does the wrong thing in — which is why this row
is not keyboard-conditional the way `Cmd+Backspace` is.

Reaching PSReadLine's own `Shift+Enter` binding, `AddLine`, would mean `win32-input-mode`: ConPTY
has no plain byte that carries the `Shift`, so no sequence at all gets there. That is a much larger
piece of work and it is not this. **`Ctrl+J` is the answer that needs nothing**, in Claude Code and
in every terminal, and so is a trailing `\` before `Enter`; both are documented by Claude Code
itself and neither is affected by anything here. They stay the fallback for a reader whose
keyboard, tmux or emulator swallows `Shift+Enter` on the way in.

`scripts/check-terminal-keys-browser.mjs` is the check, and it needs two instruments because
there are two questions. **What the page sends** is real keystrokes into a focused emulator with
every `POST /api/terminal/input` recorded — a statement about the chord rather than about
whichever shell this machine runs, and the only half a Mac chord can be asked about from a
Windows box at all, so the macOS row is asked a second time with `navigator.platform` emulated
over CDP and skipped with a printed reason if the override does not take. **Whether the shell
moves** is a known line typed at a real prompt, the chord pressed, and the server's own
scrollback asserted to hold what the motion would leave: through the browser against
PowerShell/ConPTY always, and over the API against a WSL-backed workspace when a distro exists,
because `Ctrl+Backspace` is the one that was only ever broken in front of readline.

### A paste is decided by what the clipboard is offering

A screenshot pasted into an agent running in a block reached it with `Ctrl+V`, and then only
with `Alt+V`. That is #224, and nothing was ever written for `Alt+V`: it works because nothing
claims it, so xterm sends `ESC v` and the CLI in the session reads that as "go and fetch the
image". What changed underneath it was `Ctrl+V`.

The key handler leaves `Ctrl+V` to the browser on purpose — see the section above, and #136 —
because handing it to the shell means sending `\x16` whether or not there was anything to
paste, *and* cancelling the paste event xterm is listening for. What that did not account for
is that **the browser's paste into xterm reads one flavour**: `clipboardData.getData
('text/plain')`. A clipboard holding a bitmap and no text pastes an empty string, so the block
sent the program **nothing at all** — not the image, which cannot travel over a PTY, and no
longer the keystroke it would have used to fetch the image itself.

So the rule is written on what the clipboard is offering rather than on the chord:

- **text pastes**, exactly as it did. That is what #136 bought, and what pasting a path or a
  command relies on.
- **an image and no text sends `\x16`**, which is what `Ctrl+V` has always meant on a terminal
  and the keystroke the program acts on.
- **an image *and* text is a text paste.** Text paste is the older promise; the opposite is
  defensible and this is a call made rather than a fact discovered.
- **an empty clipboard is nothing.** A rule written as "no text" rather than as "an image"
  would fire on every paste of nothing and send a `\x16` nobody asked for.

It lives in a **capture-phase `paste` listener on the card** rather than in the key handler,
and both halves of that matter. A `keydown` cannot know what the clipboard holds, since the
default action has not fired yet. And a rule written at the paste event is keyboard-agnostic,
so **`Cmd+V` on a Mac comes for free** with no second entry in `terminal-keys.ts` — the key
handler already returns false for both chords, which is what leaves the browser's own paste to
fire for either one. Capture, because xterm listens on its own hidden textarea *below* the
card and stops the event there; the capture pass goes root-first and has already happened by
then. `clipboardImages()` in `src/core/pasted-images.ts` answers "is there an image on this
clipboard" for the issue card too, so the board and the block have one answer rather than two.

`Alt+V` is left working. It costs nothing, it is the habit this was reported from, and it is
still accidental rather than designed — nothing claims it, so xterm sends the meta escape.

**This assumes the program in the block reads the clipboard of the machine it runs on**, which
holds while the board is served over loopback — which is how it is run, see
[running.md](running.md). A browser driving a board on another machine would paste the
*server's* clipboard rather than the reader's; written down rather than solved.

`scripts/check-terminal-paste-browser.mjs` is the check, and it asks the rule twice over.
Once with the **real chord against the real clipboard**: the clipboard permission granted over
Chrome's browser target, an `image/png` `ClipboardItem` written with `navigator.clipboard.write`,
and `Ctrl+V` pressed for real — skipped with a printed reason where the write is refused, since
a headless clipboard is the machine's rather than the check's. `Cmd+V` is asked only on a Mac,
because which chord fires the browser's *paste* is the platform Chrome is running on rather than
`navigator.platform`, and no user-agent override reaches it. Once more with a **synthesised
`paste`** dispatched at the emulator's own textarea, which needs no clipboard, runs everywhere,
and is the half that says the rule is not keyed to a keyboard at all.

## Erasing it does not get rid of it

The block is not `locked`, and `locked` is the only thing Excalidraw's eraser respects
(`if (element.locked) { return; }`). Locking it would take away the selection, the drag and the
corner resize that *are* the interface here, so the block stays erasable and **the erase is
undone instead**: the board notices, in `syncTerminalBlocks`, that it has lost a block whose
shells are still running, and puts one back where the reader had it — the size and the position
it was erased at, not re-anchored beside the mirror. A block with two tabs comes back as one block
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

### `s1` on one board is not `s1` on another

`nextTerminalId` counts from 1 **per board**, so the first shell of every project is called `s1`.
Everything the browser remembers per session is therefore keyed by board *and* session
(`terminalKeyOf`): where each block sits, and what grid each shell has been told.

Unqualified, the restore above turned into a leak between projects, which is #156. Switching
tabs takes the old board's blocks off the scene, and to the restore that is indistinguishable
from an erase; the board being switched *to* has an `s1` of its own; so the restore looked `s1`
up, found where the reader had dragged the other project's terminal, and put this project's
block there — at that position and that size, with the shell inside it resized to match.

The key is `sceneWorkspaceRef`, not the active board. A switch names the new board immediately
and leaves the old board's shapes on screen until the new scene lands, so for the length of a
reconnect the blocks being measured belong to the board being left. For the same reason a grid
report is skipped entirely while a switch is in flight: the request would carry the new board's
id and name a session that board has never heard of.

**A resize report names the board it was scheduled for**, through `apiUrlOn` rather than
`apiUrl`. Everything else here resolves the board late on purpose — a handler that never
re-renders must not send the board it closed over — but this one is debounced and retried, so
read late it arrives at whichever board the reader switched to while it was waiting, naming a
session id that board has one of its own. What that costs is not a stale label: it is a live
full-screen program on the other project repainting into a frame that is not its own. It was
invisible until the caches stopped being wiped on a switch, because the wipe made the board
being returned to re-report its true size and heal it a moment later.

Nothing is wiped on a switch any more, either. It used to be, and that was both insufficient —
the old scene stays up, so the geometry was written straight back in — and lossy: where a reader
put a project's terminal is that project's, and visiting another tab is not a reason to forget
it. A board returned to puts its block back where it was left.

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
- `scripts/check-child-session-env.mjs` — that `CLAUDE_CODE_CHILD_SESSION` is not passed on,
  on the PTY path, the pipe path and the agent path, and that a sentinel variable beside it
  still arrives — the board strips one key rather than filtering the environment. It starts
  its own servers holding the marker, because whether any given machine's board holds it
  depends on how that board was started.
- `scripts/check-implement-terminal.mjs` — a run opening a session by itself, the session naming
  the issue that owns it and starting in the worktree of the run, its output arriving as two
  messages while the process is still alive, and the run settling `done` with its pull request.
  Then the half that matters more: with the terminal off, with `EXCALIDRAW_TERMINAL_PTY=0`, and
  with the cap already full, the run still starts, still settles, and says it had no tab.
- `scripts/check-implement-interactive.mjs` — the two shapes of command side by side. A command
  without `-p` gets `mode: pty`, is still labelled with its issue, is handed its whole prompt as
  an argument with its stdin left a terminal, carries a keystroke through to the process and
  back into the transcript, and settles `done` with the pull request it printed. A command with
  `-p` gets `pipe`, its prompt on stdin, `readOnly: true`, a **409** for a keystroke and nothing
  of it in the transcript — and settles exactly as it always did. Self-contained.
- `scripts/check-implement-terminal-browser.mjs` — the same run, in Chrome: a tab appearing with
  nobody clicking for it, labelled `#128` rather than `s4`, its screen drawing the agent's output
  while the record still says `running`, and the block still selectable and still resizable by
  its own corner afterwards.
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
- `scripts/check-terminal-workspace-isolation-browser.mjs` — also in Chrome, and two projects:
  the reader drags and shrinks the block on one board, switches to the other, and the second
  board's `s1` gets a block of its own at a fresh size rather than the first board's — asserted
  on the canvas, and through `GET /api/terminal` per board, where a shell placed in the wrong
  frame shows up as a shell running at the wrong grid. Then back to the first board, whose block
  is still where it was put.
- `scripts/check-terminal-font.mjs` — the arithmetic behind the size buttons: the cell, the
  frame and therefore the grid all move with the font, the grid never grows on the way up the
  range, and no size in it asks for a screen the block cannot hold.
- `scripts/check-terminal-font-browser.mjs` — the buttons themselves, in Chrome. Clicked with a
  real pointer, the grid the *shell* was told changing with them, a line exactly as wide as the
  header's claim drawn with its last column inside the block, the shape still selectable and
  still resizable by its corner afterwards, and the size still there after a reload.
- `scripts/check-terminal-rows-browser.mjs` — #104's, and since #115 **both** axes. At zoom 1,
  where a scene unit is a pixel, at the default size and at both ends of the range: the screen
  xterm drew inside the frame that holds it, and the rows *and columns* the shell was told no
  more than the frame can draw and no more than two fewer. Plus a marked last line printed into
  the bottom row and seen inside the block. Every number is read off the render, because a check
  that divided by the same wrong cell the code did would have agreed with it. The width half was
  seen to fail against the face swapped with the cell left behind: 97 columns claimed of 104 at
  13px, 159 of 170 at 8px, 51 of 55 at 24px.
- `scripts/check-terminal-default-grid-browser.mjs` — that a fresh block opens at 125 × 30, and
  that it is a *grid* it opens at rather than a rectangle that happens to divide into one on the
  machine the number was picked on. The grid is asked of `GET /api/terminal`, which is what the
  shell was really told; the rectangle is checked against `terminalSizeFor` run on the cell the
  page itself measured. Three cases, and the third is the one a re-picked constant cannot pass:
  with the reader's text stepped to 24, the *next* board's fresh block is 125 × 30 again, at a
  rectangle a third bigger. Same screen, two rectangles. Written first, red on the old code on
  twelve cases — a default of 154 × 29 where the file claimed around 150 × 33.
- `scripts/check-terminal-paper-browser.mjs` — the look, in Chrome, in **both themes**, and
  every case in it is one the source cannot answer. The theme is pinned rather than inherited
  from the machine's `prefers-color-scheme`, and each case is asked once on paper and again on
  night. The card's surface and the block's are compared as **rendered pixels** — the same two
  screen coordinates, once with the overlay over them and once with it out of the way, since
  the filter that darkens one of them applies at paint and every colour the DOM will report is
  the colour before it. That is the case #147's defect hid behind: the string comparison it
  replaces compared `#faf6ee` with `#faf6ee` and passed while the screen showed a bright card
  in a dark ring. Then: the four Comic Shanns faces registered on the document *and* loaded;
  the rows asking for the face first and the glyphs really 0.55 wide per font pixel, which is
  how a fallback gives itself away; all sixteen ANSI colours, printed by a real shell and read
  back off the render, clearing 3:1 against **their own theme's** surface; a band of its own
  colour still crossing the block at zoom 0.15 in both; and the toggle itself — done with a
  program on the alternate screen and the emulator's DOM node marked, so an emulator that was
  rebuilt rather than re-themed would lose the mark and be caught.
- `scripts/check-terminal-pairs-browser.mjs` — the other half of that question, and #159's: each
  of the sixteen as a **page** rather than as ink. A real shell prints all sixteen as
  backgrounds inked with ANSI `black`, plus `brightWhite` on the two greys dim enough to take
  it, plus Claude Code's own chip in Claude Code's own words; every pair is read back off the
  render as `color` and `background-color`, in both themes. The named sets are asserted
  **exactly**, so a slot that drifts into reach fails it as surely as one that drifts out — the
  same lists are prose in `terminal-palette.ts` and here, and a list true in one place only is
  what this document has paid for before. Two structural cases carry the rest: that `black` is
  the strongest ink of the sixteen on paper, and the one closest to the surface on night, since
  a `black` that drifts back into the middle of the ramp is precisely how this defect happened.
- `scripts/check-terminal-scrollbar-browser.mjs` — the bar, in Chrome, and the strip it is drawn
  in. A thumb painted in that strip once there is more output than one screen and nothing
  painted there while a session still fits on one — read back off a **screenshot** of the strip,
  because a native scrollbar is drawn by the browser and no API in the page has a box to
  describe it. The thumb dragged, moving the viewport and the transcript on it while the
  server's own `scrollback` stays byte-identical and the shell is told no new grid: a bar is a
  viewer. The rightmost column the shell was told about drawn in full and clear of the strip, at
  8, 13 and 24, with a ruler exactly `cols` wide — the geometry says the screen box ends before
  the strip, the ruler says the last character in it was painted there. And the wheel unchanged:
  one it can use still scrolls the scrollback, one it cannot still reaches the canvas. It is the
  one browser check here that does **not** pass `--hide-scrollbars`, which would otherwise let
  every case in it pass by measuring nothing.
- `scripts/check-terminal-focus-browser.mjs` — who owns the pointer where, in Chrome. A click
  in the middle of the screen focusing the shell and a command typed straight after it running;
  a drag on the header moving the block and a drag on the screen selecting text and *not*
  moving it; Ctrl+C copying that selection and, with nothing selected, still interrupting; the
  wheel scrolling the scrollback and, when there is none left to scroll, reaching the canvas;
  the sideways half of a wheel reaching the canvas *while* the vertical half is being used —
  by the scrollback, and by a program holding the pointer, which the check puts into that
  state by writing `1006` and `1000` into the emulator's own parser; the header still a target
  at a zoom that shrinks everything else; and the corner still resizing the block, with the
  new size reaching the server.
- `scripts/check-terminal-hotkey-browser.mjs` — who owns the *keyboard*, in Chrome, and the
  sibling of the file above. Each of Alt+B, Alt+T, Alt+P and Alt+G moving the viewport with
  real keystrokes into a focused emulator, read off `scrollX`/`scrollY` rather than off a
  handler having run; the server's own `scrollback` byte-identical across all four and the page
  having sent the shell nothing at all; a command typed straight afterwards still running, so
  the emulator kept the keyboard; Ctrl+C still interrupting and Alt+click still reaching the
  shell; and Alt+P typed into a card's bound label still a keystroke rather than a jump. Its
  sections and its mirror are drawn *around* the block rather than away from it, so no jump
  ever takes the card off screen — an unmounting emulator writes a focus report to the shell,
  and the one case here that has to say "nothing at all" could not then say it.
- `scripts/check-terminal-keys-browser.mjs` — which *bytes* the editing chords send, and
  whether a shell moves when they arrive. The whole table pressed once each into a focused
  emulator with every `POST /api/terminal/input` recorded, then pressed again with
  `navigator.platform` emulated as a Mac over CDP, which is the only way a `Cmd` chord can be
  asked about from a Windows box — skipped with a printed reason if the override does not take.
  Then the half a byte table cannot answer: a known line typed at a real prompt, the chord
  pressed, and the server's own scrollback holding what the motion would leave — through the
  browser against PowerShell/ConPTY, and over the API against a WSL-backed workspace where a
  distro exists, because `Ctrl+Backspace` was only ever broken in front of readline. It also
  asks that the four board keys still send the shell nothing and that `Ctrl+V` still sends it
  nothing but the text on the clipboard, since the table is read *before* the AltGr bail and
  could have stepped on any of them.
- `scripts/check-terminal-paste-browser.mjs` — what a *paste* sends the shell, in Chrome, and
  the sibling of the file above. The clipboard permission granted over Chrome's browser target
  and an `image/png` `ClipboardItem` written to it, then `Ctrl+V` pressed for real: a
  screenshot and no text sends `\x16`, text pastes and does not, and a clipboard offering both
  is a text paste. Then the same four rules asked of a `ClipboardEvent` dispatched at the
  emulator's own textarea, which needs no clipboard and is what says the rule is not keyed to a
  keyboard — `Cmd+V` is asked with a real chord only on a Mac, since which chord fires the
  browser's paste is the platform Chrome runs on rather than `navigator.platform`. An empty
  clipboard sending nothing at all has a case of its own: it is the one a rule written as "no
  text" rather than "an image" would get wrong.
- `scripts/check-terminal-size-browser.mjs` — how big the block and its strip are drawn, in
  Chrome, measured off the render rather than read out of the stylesheet: #110's lesson is that
  a size which never reaches the element leaves the file reading exactly right. The block the
  board placed is the rectangle `TERMINAL_GRID` comes to against the cell that page measured,
  which is what it stopped being a constant for in #199; each of `.terminal-card__tab`, `__add`, `__detach`
  and `__merge` is 1.45–1.55× the height it has with `--terminal-tab-scale` forced back to 1,
  which is the strip as it was and the same one-lever question `check-workspace-tabs-scale.mjs`
  asks; the header beside them is unchanged; `.terminal-card__prompt` is absent live *and* with
  the shell gone; and the notice that replaced it still names `+` and Alt+T without changing
  the height of the frame the emulator was given.
- `scripts/check-terminal-overlay-layer-browser.mjs` — where the block stops, in Chrome. It pans
  a block until its *body* is spread over the whole of the page chrome — the body, because the
  title band and the tab strip above it are transparent to the pointer by design and a hit test
  through them would find the chrome either way — and then asks
  `document.elementFromPoint` what a click on the project tab, the `+`, the title, the
  connection pill and `Clear Canvas` would hit. A hit test rather than a bounding rect on
  purpose: a clipped card reports the same box it always did, so a check that measured rects
  would have been green before the fix and after it. Then `Clear Canvas` is really clicked and
  the board really emptied, with the card still over the button; and last, #112 again, because a
  fix that stopped the overlay covering the chrome by making it transparent or by moving it
  would pass everything above.

All eighteen were written first and seen to fail against the code as it stood.

Beyond them, and not automatable at a sensible price: `claude` typed into the block on a real
board, its interface drawn, a question answered, and Ctrl+C twice getting back to the prompt.
`CLAUDE.md` is explicit that compiling is not working, and this change is mostly about what the
browser does.

That last one was run by hand for #122, on a board deliberately started holding the marker, and
it is worth writing down what it showed. Through the block, `claude` started, answered, and left
a session behind that `claude --resume <id>` then reopened with its own answer still in it. The
same shell spawned with the marker still set answered the same question and wrote **no session
file at all**, under Claude Code's own warning that transcript saving was off. So the sessions
were not being hidden from a picker; they were never being written.

## What it does not do yet

- **The issue agent still runs in a private child.** #128 put the *implement* agent in a tab,
  because that is the one that runs for an hour with nothing to look at; researching an issue
  has the same gap and the same seam waiting for it — `runAgent` takes a `host`, and
  `runIssueAgent` does not pass one. It deserves its own issue.
- **An agent's tab does not come to the front when it opens.** It appears labelled and the
  reader clicks it. Bringing it forward would mean an unattended run — four of them at the
  default concurrency, and the queue starts runs with nobody watching — taking the view away
  from a shell somebody is typing in, which is worse than one click.
- **A headless agent's tab cannot be typed into**, because stdin was spent on the prompt and a
  pseudoterminal has no end of file to close it with. Watching is what it is for, and since #174
  the block says so — `readOnly` in the summary, `read-only` beside the mode, and a 409 rather
  than a 202 for a keystroke. Leaving `-p` off the command is the other design, and it is the
  section above: an interface the reader can intervene in, whose repainting screen *is* scraped
  for the pull request URL, with the exit code left out of the verdict because a reader's `×` is
  a kill. What it costs is that nothing ends such a run on its own.
- **An interactive run cannot be ended from the board except by closing its tab.** `×` kills the
  session, which settles the run from its transcript; there is nothing that says "the agent is
  finished, keep the tab". A run that printed its URL and went back to its prompt therefore sits
  there holding a slot until somebody closes it.
- **A program that turns mouse reporting on takes the pointer with it.** Once the screen has
  the pointer, `vim` or `claude` asking for mouse tracking receives clicks and the *vertical*
  wheel as escape sequences, which is what those programs expect and also means the reader
  cannot select text inside one. Nobody has asked for a way round it — a modifier that forces
  selection is what other terminals do — so it is here rather than in the design above. The
  sideways wheel is the exception #162 carved out, and it costs the program nothing: xterm
  takes a report's button from the sign of `deltaY`, so it was already sending nothing for a
  wheel that only went sideways while cancelling the event all the same.
- **A mouse report in xterm's default encoding never reaches the shell.** It leaves the
  emulator through `onBinary`, and this frontend only listens at `onData`, so a program that
  asks for `1000` without also asking for `1006` gets the pointer and then hears nothing from
  it. Every mouse-reporting program of the last decade asks for SGR, so nothing has run into
  it; noticed while writing the check for #162 and left for an issue of its own.
- **Alt+T fits the block to the viewport, which puts its top edge under Excalidraw's toolbar.**
  The path in the header reads through it awkwardly. Alt+B has the same shape of problem.
- **A tab is moved between blocks by a button, not by dragging it.** `⧉` detaches the tab on
  top and `⇥` merges into the nearest block, so the geometry is a block drag rather than a tab
  drag. Dragging a chip onto another block's strip would read better and would cost the band
  that still grabs the shape; if it is ever worth it, it is worth its own issue.
- **The tab layout does not survive a reload.** The blocks are derived, so which session was in
  which block is not saved, and a reload puts every live session back into one block. The rect
  that block comes back at *is* saved since #154; which tabs are in it is not.
- **A tab that has ended keeps its transcript but cannot be restarted in place.** `×` then `+`
  is a new session with an empty screen, in the same block.
- **Whether a shell inside WSL gets a tty of its own has not been established.**
  `scripts/check-terminal.mjs` runs a real WSL-backed session through `wsl.exe` under the
  ConPTY and it behaves — the prompt is there, `pwd` answers with the inner path — but nothing
  yet asserts `isTTY` on the far side of the distro boundary. An interactive implement run in a
  WSL-backed project rests on that answer, so it is unverified there; the delivery half is not,
  since the prompt is single-quoted into the `bash -lc` string either way.
