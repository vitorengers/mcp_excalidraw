# Issue block

Write an observation into a shape marked `customData.kind = "issue"`, click the button in its
panel, and an agent investigates the repository and opens the issue. The URL comes back onto
the block.

This spawns a process with full read access to a repository from an API that has no
authentication. It is the most dangerous thing this server does, so three guards apply and none
of them is optional:

- it only runs when `EXCALIDRAW_ISSUE_AGENT` is set, so it cannot be reached by default;
- it refuses to run unless the server is bound to loopback;
- one run at a time per element, so a double click cannot open two issues.

## The flow

`POST /api/issue-block/:id` answers **202 immediately** — an investigation takes minutes and a
held-open request would just time out somewhere else. The observation is read from the shape's
own text, or from a text element bound to it. State lands back on the element as
`customData.issueState` (`running` → `created` / `failed`), `issueUrl` and `issueError`.

A second click while a run is in flight gets 409. So does a block that already has an issue.

## Reference images

A block can carry images as well as text. Select it, pick them with **Attach reference
images** in the panel, and the agent looks at them while it investigates — a screenshot of
the thing that is wrong says in one image what a paragraph gets approximately.

**They are reference material, not issue content, and that boundary is forced rather than
chosen.** `gh issue create` has no attachment flag, and the endpoint GitHub's own web client
uploads to is not public API, so an image cannot reach the issue itself without being hosted
somewhere first. The prompt therefore tells the agent what the images are for: read them,
and write out in words whatever the issue depends on.

The ids live on the block as `customData.issueImages`, an explicit list. Excalidraw binds
text to a container but not images, so "the images in this block" had to be invented — and a
list was preferred over group membership because a group is a user-facing concept: grouping a
card with its neighbours for layout would silently change what the agent sees, and ungrouping
would silently take it away.

The bytes go to the file store (`POST /api/files`), not onto the element. An element carrying
dataURLs would ride in every autosync payload and every export of the board. `GET /api/files/:id`
reads one back, which is what draws the thumbnails in the panel.

### How they reach the agent

The prompt is one string on stdin and there is no second channel — base64 pasted into it
would be megabytes the agent cannot decode. What it does have is `Read`, which renders an
image. So each attached dataURL is decoded to a file **inside the project**, under
`.excalidraw-issue-images/<element id>/`, and the prompt names the paths.

Inside the project for two reasons. A WSL-backed project runs through `wsl.exe`, and a
Windows temp path has no spelling that distro can open — but the project has one, `innerPath`,
which is the translation the prompt carries. And a file under the working directory is one the
agent is unambiguously allowed to read; in `-p` mode a refused tool call is silent, so an
image outside the project would fail as an agent that merely ignored it.

The directory exists only while the run does. It is removed when the run ends, on the failure
path as well as the success one, and the empty parent goes with it.

Three things are deliberate:

- **A block with nothing attached sends the prompt it sent before this existed, byte for
  byte.** A feature nobody used must not change what every block already does.
- **A dead id costs nothing.** A `fileId` with no image behind it is skipped and the run
  goes ahead — losing an investigation over a missing image would be the worse trade.
- **The store is in memory.** Files are not written to disk and not exported with the board,
  so an attachment does not survive a restart of the server. Attach and run in one sitting.

Attaching is offered only before the run. Once a block has an issue there is nothing left for
an image to inform, and attaching one does not make the block runnable again.

## After the issue exists

The block is retitled to the issue it produced: `customData.issueTitle` is stored and the bound
label is rewritten, with the original text kept as `customData.observation`. The observation is
what started the run, but once the issue exists the title is what the card is *about* — a board
full of raw observations reads like a scratchpad.

Selecting the block then renders the issue body in the panel, through the same `marked` +
`DOMPurify` path the docs block uses. The body is fetched from `GET /api/issue-block/:id/issue`
at selection time rather than stored on the element, for two reasons: kilobytes of issue text on
every block would ride in every autosync payload and every export, and a stored copy would go
stale the moment anyone edited the issue on GitHub. Only the title lives on the element, because
a card has to read correctly with nothing selected and with no network.

That route shells out to `gh issue view --json` and carries the same loopback guard as the run
route — reading is not writing, but it still spawns a process holding your `gh` credentials.
`EXCALIDRAW_GH_COMMAND` overrides the binary so `scripts/check-issue-detail.mjs` can stub it.

## Adding observations

A created block's panel has two actions on one row: **Add observations** and
**Implement / Fix**. The first opens a box, and what is typed there is posted to the issue as a
GitHub comment by `POST /api/issue/comment`. The comments are read back with the issue and shown
under its body.

**It exists because the board asks questions it then has to answer itself.** The issue agent is
told to end with the open questions rather than fill a gap with a guess; the implement agent is
told it is unattended and must decide those questions alone. Between the two runs there was
nowhere to say anything — an answer, or whatever the observation left out, had to be typed on
github.com in another window.

Four things are deliberate:

- **A comment, not an edit to the body.** It is the one place both the implement agent and a
  human reviewer read, and it cannot damage a body an agent spent twenty minutes writing. The
  original `customData.observation` is untouched too.
- **Verbatim, and therefore on stdin.** A comment is free text — quotes, backticks,
  `$(echo hi)` — and `runGh` appends its argument to a command line that a WSL workspace runs
  through `bash -lc`. So the body goes to `gh issue comment --body-file -` through
  `RunGhOptions.stdin` and never appears in argv; the only thing interpolated is the URL, which
  `isIssueUrl` has already matched. `scripts/check-issue-comment.mjs` compares what a stub `gh`
  received on each.
- **It changes nothing else.** No agent runs, `issueState` stays `created`, a finished
  implementation is not cleared and the block does not become runnable again. The button is
  offered for as long as the issue exists, including while an implementation runs — which is
  exactly when something forgotten tends to turn up. An observation added mid-run reaches
  GitHub but not the agent already working, which read the issue when it started.
- **The loopback guard, and only that.** It writes to GitHub, so a canvas reachable from the
  network must not reach it; but it starts no agent and touches no repository, so it is guarded
  like `POST /api/project-board/move` rather than like the implement routes.

`IMPLEMENT_AGENT_PROMPT` now sends the agent to `gh issue view --comments` as well as
`gh issue view` — piped, that flag prints the comments *instead of* the body, so both calls are
needed — and says that where a comment and the body disagree, the comment is the later word.

## The prompt

`ISSUE_AGENT_PROMPT` in `src/core/issue-agent.ts` tells the agent to investigate before writing:
find the root cause and cite it as `file:line`, check whether an open issue already covers it,
read the project's documentation before proposing a solution. Then write context, root cause or
competing hypotheses, scope, a verifiable definition of done, and the assumptions — and never
fill a gap with a guess presented as fact.

It also fixes the output language, and the reason is less obvious than it looks. Issue #20 came
out entirely in Portuguese from an observation written in English — the observation's language
is not what decided it. Step 3 sends the agent to read the project's own documentation before
proposing anything, and that project documents in Portuguese, so the agent took the language
from its surroundings. Nothing in the prompt said otherwise. Now it names English outright.

## Implementing the issue

A created block carries an **Implement / Fix** button above the description.
`POST /api/issue-block/:id/implement` runs an agent inside the project to implement that
issue, and the pull request URL comes back onto the block the way the issue URL did.

**It is a different agent with different powers, and that is the whole point.** The issue
agent is deliberately powerless — `gh`, `git` and reading, nothing that writes. An agent
that implements must write code, run the build and run the checks, so it needs `Write`,
`Edit` and an unrestricted `Bash`. Sharing a command between the two would mean that
turning on issue blocks quietly turned on repository writes, which is not a decision
anyone would have made on purpose. So it has its own variable and is **off until it is
set**:

```
EXCALIDRAW_IMPLEMENT_AGENT='C:/Users/vtr_d/.local/bin/claude.exe -p --model claude-opus-5[1m] --effort high --dangerously-skip-permissions'
```

`--dangerously-skip-permissions` rather than a list of tools, because an enumerated list is
also a *deny* list: in `-p` mode there is no prompt to answer, so a tool outside the list is
simply refused, and an agent stopped from reading a page of documentation has been stopped
by the configuration rather than by anything it did. The flag's own help says it is
recommended only for sandboxes with no internet access; using it here is a deliberate
choice, made by whoever runs the board, to let the agent do the work.

The other guards carry over — loopback only, one run at a time per element — and one is
added: a block with no issue has nothing to implement, and a block that already produced a
pull request will not produce a second one.

### The card moves when the run starts

If the workspace has a project, starting a run moves that issue's card to **In Progress** and the
mirror picks it up on its next poll. The write is the server's, made where the run is started, so
it happens whether the click came from an authored block or from a mirrored card — and it does not
depend on an agent obeying an instruction it might die before reaching.

It is best-effort by design: no project, no such column, an issue that is not on the board, or a
`gh` that fails are all logged and nothing more. The run still starts. `docs/project-board.md` has
the column-resolution rule and `projectInProgressColumn`.

### No time limit, and the way back

Researching an issue keeps its twenty-minute ceiling: it is bounded work, and that number
came from a real run. **Implementing has none.** A clock that kills a working agent halfway
through a change leaves a branch nobody asked for and no pull request, which is worse than
a run that takes an hour. `EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT` (seconds) puts a ceiling
back for anyone who wants one.

The ceiling was not decoration, though — its job was that a wedged run could not hold a
block in `running` forever. With it gone, that guarantee comes from the card instead: a
running block offers **Reset — the run was lost**, and `DELETE /api/issue-block/:id/implement`
clears the state.

That reset clears state; it does not stop an agent. Nothing here can reach into a process
the server no longer owns. What it does do is refuse — 409 — while a run is in flight *in
this process*, which is the case that matters: the element cannot tell a live run from an
abandoned one, and the server can.

### One checkout per run

Every implementation gets a **git worktree of its own** — `<project>-worktrees/issue-<n>`, on a
branch of the same name cut from the default branch — and the agent is started there rather than
in the project directory.

Before this, every run was spawned into the same working tree. The server serialised by issue
URL, so one issue could not become two pull requests; but the thing the agents contend for is not
the issue, it is the checkout. Two *different* issues passed every guard and landed in one
directory: both running `git checkout -b`, the second cutting its branch from the first one's work
in progress or failing against a dirty tree; commits landing on whichever branch happened to be
current; both builds writing the same `dist/`, so each verified against the other's artifacts. The
runs are unattended by design, so nobody was watching it happen.

Worktrees are what Claude Code itself uses for parallel agents: one repository and one object
store, several checkouts, each on its own branch. Three decisions came with them.

**They live beside the project, not inside it.** A checkout nested in the repository is a second
copy of every file the type check, the build, the board export and the checks all walk, and being
outside is one `.gitignore` rule nobody can forget.

**`node_modules` is linked in**, as a junction on Windows and a symlink under WSL. It is not
tracked, so a fresh checkout has none, and an agent told to run the build would find no compiler
there; an install per run would cost minutes and gigabytes to arrive at the same tree.

**A worktree with uncommitted work is never removed.** A run that ends clean takes its worktree
with it, and its branch too when git agrees the branch is merged — `git branch -d` refuses an
unmerged one, which is exactly the branch a pull request was opened from. A run that ends with
changes still uncommitted keeps everything: those changes are the only copy of themselves, and an
agent that died partway through a change leaves precisely that. The path is logged and reported on
the record, so `GET /api/implement` says where the work is.

A workspace that is not a git repository gets no worktree and runs in the project directory, the
way everything did before. Isolation is what a repository buys; nothing else changes.

### How many at once

`EXCALIDRAW_IMPLEMENT_CONCURRENCY` caps the implementations one workspace may have in flight,
and **defaults to 4**. Over the cap, `POST` answers 409 and names the runs holding the slots.

It used to be unlimited, and unlimited by accident — nothing counted runs, because the only guard
was per issue. Now that each run has a checkout of its own, several at once are safe rather than
merely tolerated, so the default is greater than one; it is small because every run is a whole
coding agent building and testing on one machine. `0` removes the cap, `1` serialises.

`GET /api/implement` with no `url` lists every run for the workspace — the question parallel runs
create is "what is running right now", and until this existed the state was reachable only one
issue URL at a time, by a caller who already knew which URL to ask about. Finished runs are listed
too, because one of the things worth knowing is which run left a worktree behind.

State still lives in memory, so a restart loses it while the worktrees survive on disk. Nothing
reconciles the two: a worktree left by a run the server has forgotten stays where it is, which is
the same trade the **Reset — the run was lost** affordance already makes.

### What the agent is told

The workflow is **not** in the prompt. Each project records how work is done in it — branch
naming, whether a change ships with a check, whether the agent opens a pull request or
merges it itself — and the agent runs inside that project, so it is told to read its own
project memory and treat that as the authority. Writing this repository's conventions into
the prompt would make the feature wrong for every other board. This repository's own answer
now lives in a tracked `CLAUDE.md` instead, where a fresh clone can find it, rather than in
one machine's local agent memory.

What the prompt does carry is what an unattended run needs: investigate before changing
anything and stop if the issue is already fixed; implement the smallest change that meets
the definition of done and no more; run the project's own checks and read the output,
because compiling is not working; and — since nobody can answer a question mid-run — decide
the issue's open questions, state the call in the pull request, and keep going.

One thing is appended to it: where the run is happening. That is not workflow — it is a fact
about the process the agent was started in, and one it cannot discover without going looking.
Without it an agent reads its memory, finds "branch off the default branch", and cuts a second
branch inside a checkout that already is one; still isolated, but the branch the pull request
was expected on goes unused. A workspace with no worktree gets no such paragraph, and sends
the prompt it sent before this existed, byte for byte.

## Configuration

```
EXCALIDRAW_ISSUE_AGENT='C:/Users/vtr_d/.local/bin/claude.exe -p --model claude-opus-5[1m] --effort high --allowedTools "Bash(gh:*) Bash(git:*) Read Grep Glob"'
EXCALIDRAW_ISSUE_AGENT_TIMEOUT=1200
EXCALIDRAW_IMPLEMENT_CONCURRENCY=4
```

**Pin the model and the effort.** Without `--model` and `--effort` the agent inherits whatever
`~/.claude/settings.json` happens to say, so changing the model of an interactive session
silently changes who writes the issues — and that is not a change anyone would think to look for
when an issue comes out worse than usual. The `[1m]` suffix selects the 1M-context variant.

`--allowedTools` is mandatory. In `-p` mode the agent investigates fine, but any command needing
approval is blocked, so it finishes with exit code 0 and no issue at all. The list is narrow on
purpose — `gh`, `git`, and reading. No `Write`, no `Edit`, no open `Bash`: the agent opens
issues, it does not touch the repository.

A WSL-backed project runs through `wsl.exe --cd <innerPath>`, because the agent has to see the
repository the way `git` and `gh` inside that distro do.
