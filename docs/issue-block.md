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

There is no time limit on the run, and a block stuck in `running` can be reset —
[No time limit, and the way back](#no-time-limit-and-the-way-back) covers both agents.

## Writing the observation

Writing into a block is typing into Excalidraw's own bound-label editor, and that editor
commits on exactly two keys: **Escape**, and **Ctrl/Cmd+Enter**. Plain Enter matched neither,
fell through to the textarea and inserted a newline — so the one key a reader reaches for to
say *done* was the one key that did not finish. There is no prop, option or callback that
changes it; the handler is `editable.onkeydown`, assigned as an element property inside
`textWysiwyg`.

So the board takes the key before that handler runs, with a capture-phase `keydown` listener
on `document` — the same manoeuvre the paste path makes, for the same reason: an
element-property handler runs at the target phase, so capturing at `document` is what gets
there first, and stopping the event is what keeps the newline from being typed.

- **Enter** finishes the edit. The text is committed to the label and the block stays
  selected, so the card is still on screen.
- **Shift+Enter** breaks the line. That is where the newline went, and the interception is
  written so as not to swallow it.
- **Escape** and **Ctrl/Cmd+Enter** are untouched. They already finished, and removing a
  keystroke people have in their fingers buys nothing.
- **Every other label on the board** is untouched too. Enter still inserts a newline there;
  the listener fires only when the open editor belongs to a shape carrying
  `customData.kind === "issue"`.
- **A composition in progress** is let through, or Enter-to-confirm an IME candidate would
  close the editor mid-word.

**A selected issue block therefore changes what Enter does on the canvas, the way it already
changes what Ctrl+V does**, and the card says so for the same reason — a keystroke nothing on
screen mentions is a keystroke nobody tries.

Two decisions inside it are worth naming.

**Enter finishes the edit; it does not start the run.** Starting the agent is an unattended
process with repository access, and inferring that from a key that means "done writing" would
be a guess with consequences. The button on the card stays the only way in.

**The finish is a synthetic Escape at the textarea, not a `blur()`.** `onSubmit` re-selects
the container *only when the submit came from the keyboard*, so blurring commits the text and
leaves nothing selected — which closes the card the reader wants next. The synthetic event
does not bubble: the editor's own handler is all it needs to reach, and an Escape loose on the
page is a different keystroke with its own meanings.

`scripts/check-issue-block-enter-browser.mjs` drives a real Chrome, because which of two
handlers wins is not a question a type check can be asked. It presses Enter with its text
(`\r`) attached rather than as a bare key: a newline in a textarea is the *default action* of
the keypress, so a key event with no text would pass every case while inserting nothing.

## Reference images

A block can carry images as well as text. Select it and either press **Ctrl+V** with a
screenshot on the clipboard or pick a file with **Attach reference images**; the agent looks
at them while it investigates — a screenshot of the thing that is wrong says in one image
what a paragraph gets approximately.

**The paste is the way a screenshot actually arrives.** `Win+Shift+S` and `PrtScn` produce a
bitmap with no path on disk, which is precisely what a file picker cannot reach, so while
attaching was picker-only the flow was: paste into another application, save a file, then
find that file in the picker. Nothing below the entry point had to change — an image read off
a `paste` event *is* a `File`, already typed `image/png` — so a pasted attachment and a picked
one are the same thing from `attachIssueImages` onwards.

### Which handler wins

Excalidraw registers its own `paste` on `document` and turns the image into a scene element.
The ordinary gesture — click the block, the card opens, Ctrl+V — leaves focus inside the
Excalidraw container with the cursor over the canvas, which is *exactly* the case Excalidraw
claims: a handler scoped to the card would never fire in the one case the feature is for. So
the panel captures at `document`, ahead of the bubble-phase listener there, and stops the
event.

**A selected draft block therefore changes what Ctrl+V does on the canvas, and that is the
decision.** The alternative — requiring a click into the card first — is discoverable only if
the card says so, and the block is selected because the reader just chose it. What the panel
does *not* take is bounded to match:

- nothing selected, or a block whose state is `running` or `created`, and the listener is not
  registered at all — the card is where it lives, and the card is not there;
- anything being typed into keeps its own paste, so Excalidraw's text editor and the
  observation box are untouched;
- a clipboard with no image on it is let through rather than swallowed.

The card says so too: the hint under the button names the keystroke, because a gesture nothing
on screen mentions is a gesture nobody tries.

`src/core/pasted-images.ts` owns the three decisions — which of a clipboard's contents is an
image, whether the block showing may take one, and what to call a file that arrived without a
name. `panelTakesPaste` is the same condition that puts the button on screen, written once so
the two cannot drift. `check-pasted-images.mjs` holds the arithmetic and
`check-pasted-images-browser.mjs` drives a real Chrome, because which of two `document`
listeners wins is not a question a type check can be asked.

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

Attaching is offered only before the run — by either route. Once a block has an issue there is
nothing left for an image to inform, and attaching one does not make the block runnable again.
Issue #53's **Add observations** is what a created block gets instead.

## What a block looks like

A block used to look the same at every stage. `draft`, `running`, `created` and `failed` were
four states with one appearance, because appearance was authored once in
`docs/blocks.excalidrawlib` and only ever copied afterwards — no code owned the question.
`src/core/issue-appearance.ts` owns it now, as one pure function from state to colours.

| Stage | Outline | Stroke | Fill |
| --- | --- | --- | --- |
| `draft`, `running`, `failed` | dashed | `#f08c00` | `#fff9db` |
| `created` | solid | `#e67700` | `#fff3bf` |

**Dashed means there is no issue behind it yet; solid means there is.** The second stage is the
first one step down the same ramp rather than a new colour, so a board reads as one thing at a
glance and the change still survives being squinted at.

`running` and `failed` deliberately keep the first-stage look. Both are blocks with no issue
behind them, which is exactly what the dashed outline already says, and the panel reports which
of the two a block is in. `check-block-appearance.mjs` holds the draft values against the ones
the library ships: a mapping that disagreed with the library would repaint every block the first
time anything touched it.

The appearance is written by the server, in the same `markState` that writes
`customData.issueState`, rather than derived in the browser. That is where the state is
authored, so the look persists, exports with the board, and reaches every connected tab on the
update that already carries the state — a browser deriving it on render would have to derive it
again on every path that draws a block, and a block saved to `docs/board.excalidraw` would go
back to looking like a draft.

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

The query asks for `stateReason` and `closedByPullRequestsReferences` as well as the body and the
comments, so that a closed issue can say **what** closed it. "Closed" and "closed by a pull
request" are different facts, and the second one is a field rather than an inference. A `gh` too
old to know those two answers `Unknown JSON field`; the reader notices that once and drops back to
the older list, because turning every issue read into a hard error would be a poor price for a
link.

### Read once, remembered, revalidated

Fetching at selection is right; fetching at *every* selection was not. The panel is unmounted
whenever nothing is selected, so its knowledge of an issue died with it and the next click on the
same block spent another `gh issue view` — a little over a second here, nearer two when the first
attempt drops at connect — re-reading text that had not changed. Worse than the wait was what the
wait was drawn from: `offersImplement` treats an unread `githubState` as *unknown* and keeps the
button, on purpose, so a closed and shipped issue offered **Implement / Fix** for that whole
second, every time.

So a read issue is now remembered in two places, and on neither of them is it stored:

- **In the browser**, `frontend/src/issue-cache.ts` — a module-level map keyed by workspace and
  issue URL, outside the panel's lifecycle because the panel is the thing that keeps dying. A
  remembered issue paints at once, with its title, body, comments and the right buttons, and the
  read still goes out behind it. A revalidation that fails keeps the remembered copy rather than
  replacing it with an error: `gh` drops a socket here often enough that the alternative would be
  worse. One that succeeds replaces the panel's contents silently — it only ever moves towards
  what GitHub says.
- **In the server**, `src/core/issue-memo.ts` — the same key, in front of `fetchIssue`, for
  `EXCALIDRAW_ISSUE_MEMO_MS` (30 s by default; `0` turns it off and leaves the server as it was).
  Reads that arrive while one is in flight join it rather than starting their own, so a burst of
  clicks, or two tabs on one board, is one process. A failed read is never remembered.

It is dropped, rather than waited out, where the server already knows the issue changed: posting
an observation (`POST /api/issue/comment` re-reads afterwards, and that read becomes what the next
selection is served) and `recordImplement`, because a run ends in a pull request and a pull
request is what closes an issue. The panel writes the same three actions through to its own cache.

**Both are session memory**, lost on a reload and on a restart, like the implement record and the
file store. Anything that survived those would be the stored copy this section rejects: what the
cache buys is the frame, not the freshness.

The first frame is the point, so the panel decides what to show **during render** rather than in
an effect — an effect runs after the browser has painted, and one frame of the previous
selection's issue with the previous selection's buttons is this defect in miniature.
`scripts/check-issue-cache-browser.mjs` asserts against a stub `gh` that sleeps two seconds, so
nothing it sees can have been fed by the read; `scripts/check-issue-cache.mjs` counts the stub's
invocations.

The mirror is the other half. A card is redrawn from GitHub on every poll and is the wrong place
to remember anything — but the mirror already *writes* the run onto it, because that is what the
card's outline is drawn from, and `resolvePanelTarget` used to hardcode `implementState: null`
anyway. A card sitting in **In Progress** therefore offered to be implemented until a `gh` came
back, with the answer sitting on the shape under the pointer. It is read off the card now.

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

### What an agent may hand to a helper, and what it may not

Both prompts end on the same contract: **the last line you print is the URL**. The server reads
exactly that, `extractGithubUrl` over the parent's stdout — so the contract holds only while the
parent is the one that finishes. Nothing said so until a run broke it.

Asked for orchestration, the issue agent delegated to a background sub-agent. The sub-agent created
issue #75; the parent sat waiting and printed nothing. The block stayed `running` forever, beside a
mirrored card for an issue that already existed, and neither `adoptIssueTitle` nor `reconcileDrafts`
could act — both match on an `issueUrl` the block never received.

So both prompts now say helpers are allowed and name two things that do not travel with the work.

**Creating is the parent's.** A helper investigates and reports back; it never runs
`gh issue create`, and on the implement side never opens or merges the pull request. This is the
half that matters more, and not for the reason the failure suggests. The server's guard is one run
per block — not one `gh issue create` per run. Three helpers that each create leave three issues for
one observation, and nothing anywhere counts them.

**Finishing is the parent's.** Only what the parent prints is read, so it waits for every helper to
come back and prints the URL itself, last, whoever did the work and whatever a helper already made.

`scripts/check-agent-delegation.mjs` holds both prompts to those rules. It captures each one as its
agent receives it, over stdin, through the real composition path — and it says in its own header
what it is: a lint over instructions. It cannot show an agent obeys. It fails when the guidance is
dropped or reworded away, which for prose is the regression that actually happens.

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

### A closed issue is not offered

The button used to be decided by the run record alone — `implement.state` neither `done` nor
`running` — so a closed, shipped issue still offered to be implemented, even though the panel
had already read the state it needed to know better and was showing it beside the link. It now
takes both facts: the record says whether an agent is already on it, the issue says whether
there is anything left to do (`offersImplement`, `src/core/issue-appearance.ts`).

A closed issue is named rather than merely emptied of controls:

- closed by a pull request — the pull request is linked, because "was this actually shipped" is
  the question a Done card raises and GitHub answers it;
- closed with none — *Closed. No pull request is recorded as closing it.* That is the ordinary
  shape of an issue closed by hand, not a missing link;
- closed as not planned — *Closed as not planned.* A decision, not an omission.

An issue that has not been read yet keeps the button it had. An unread issue is not an open
one, but a control that appeared a second after every selection would read as a glitch.

### The card moves when the run starts

If the workspace has a project, starting a run moves that issue's card to **In Progress** and the
mirror picks it up on its next poll. The write is the server's, made where the run is started, so
it happens whether the click came from an authored block or from a mirrored card — and it does not
depend on an agent obeying an instruction it might die before reaching.

It is best-effort by design: no project, no such column, an issue that is not on the board, or a
`gh` that fails are all logged and nothing more. The run still starts. `docs/project-board.md` has
the column-resolution rule and `projectInProgressColumn`.

### And when the research run finishes

The same write, one step earlier. A block is drafted in the first column — `My Notes` by
convention — and the issue the agent creates is left there too, because GitHub's *Item added to
project* workflow assigns the first option. Once the issue exists it is no longer an observation
waiting to be looked at, so the server moves it to **Todo**.

Best-effort in exactly the same way, and for a stronger reason: the issue is already created by
the time this runs, so nothing here may turn a successful run into a failed block. A run that
created no issue moves nothing at all. `projectTodoColumn` names the column on a board that calls
it something else.

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

**`node_modules` is hard-linked in.** It is not tracked, so a fresh checkout has none, and an
agent told to run the build would find no compiler there; an install per run would cost minutes
and gigabytes to arrive at the same tree.

It was a junction first, and that made `node_modules` a single mutable directory behind four
supposedly isolated checkouts. Anything an agent ran that cleared its own dependencies — an
`npm ci`, an `rm -rf` in the wrong place — reached through and emptied the project's. It happened
twice in one afternoon. The symptom arrives much later and looks unrelated: the next build fails
with `Cannot find package 'winston'`, in a checkout nobody touched, and the running server
survives only because it already has its modules in memory.

Hard links give each checkout its own directory entries over the same bytes: ~20k links, a few
seconds, once per worktree. Deleting them deletes links, and an agent that really does install
gets its own files. The trade is that a file *edited in place* is edited for everyone — far rarer
than deletion, and far less destructive. Under WSL the same thing is one `cp -al` rather than
twenty thousand calls across the boundary, and if hard links fail outright the junction is still
better than a checkout with no compiler in it.

`scripts/check-worktree-dependencies.mjs` holds the line by doing the destructive thing: it clears
the *contents* of a worktree's `node_modules` — the way a tool that descends does — and then looks
at the project's.

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

**The slot is claimed before the registry is read**, in the same uninterrupted step as the count.
While the claim sat below that read, two clicks arriving together both counted before either
claimed and the cap was exceeded by however many fitted in the window — which is not only a budget
overrun, because the extra run is what puts two `git worktree add` in the same instant. The cost of
claiming first is that a run refused afterwards — an unregistered workspace, a workspace that
failed to load — has to give the slot back, or the cap would leak the other way and shrink until
the server restarts. `scripts/check-implement-cap.mjs` fires more requests than the cap in one
`Promise.all` and checks both directions.

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

### Landing against a branch that moved

One checkout per run made parallel implementations routine, and parallel implementations made the
base move under a run: four agents cut from one commit, three merge, and the fourth's pull request
will not. That happened the day worktrees landed.

The agent already had what it needed — full permissions, `git` and `gh` — and was in fact
attempting the rebase unprompted. What was missing was the instruction, and one sentence pointed
the other way: *"Do not touch anything the issue does not cover"* reads, to a literal agent, as a
reason not to touch the change that just landed.

So the prompt now says the default branch may have moved while the run was working, and asks for
the branch to be brought up to date **before the pull request is opened and again before it is
merged** — current at open time is routinely not current at merge time. Conflicts are named as
part of the job rather than a reason to stop, with two qualifications that matter more than the
instruction itself: find out what the other change was for before touching it, because a conflict
resolved without reading the other side is a guess that compiles; and keeping one side wholesale is
refused in either direction, since silently dropping the change that just merged is the cheapest
wrong answer available.

When it genuinely cannot reconcile them it leaves the pull request open, says which files and what
the disagreement is, and stops. A merge that quietly discards someone else's work is worse than one
that waits for a person. And the scope sentence now carries its exception: reconciling with a
change that merged mid-run is not widening the scope, it is finishing.

`scripts/check-implement-prompt.mjs` captures the prompt as the agent receives it, over stdin,
through the real composition path. It is a lint over instructions and says so: it cannot show that
an agent obeys, only fail when the guidance is dropped or reworded away.

### Facts the repository does not settle

The two agents had opposite halves of the same gap. The issue agent was ordered to research and
denied the tools — that is the `--allowedTools` half, fixed in **Configuration** above. This one
is the mirror image: the implement agent is denied nothing, and nothing asked it to research.
Step 2 said "check the issue's claims against the code", which reads as though the code is where
every claim is settled, and step 4's *compiling is not working* arrives a step too late to help.

A library's API, a tool's flag, an external service's behaviour are none of them in the tree, and
a remembered one compiles exactly as well as a correct one. So step 2 now names that kind of fact,
says the web is there, and asks for it to be confirmed against its source rather than invented —
the same instruction the issue agent has carried since it was written, in the same words as far as
the two prompts allow.

`scripts/check-agent-research.mjs` holds **both** prompts to it, for the reason the gap existed at
all: the rationale had only ever been written down on one side. Same shape as the two lints above,
same disclaimer — captured over stdin through the real composition path, and unable to show that
any agent looks anything up.

## No time limit, and the way back

**Neither agent has a ceiling by default.** Implementing never did: a clock that kills a
working agent halfway through a change leaves a branch nobody asked for and no pull request.
Researching kept twenty minutes for a while, on the premise that it was bounded work —
reading and drafting, and the number came from a real run. That premise went. The
investigation also reads reference images, existing issues and the project's own
documentation now, and a real run was killed at 1200s **having already created its issue**,
reported as a failure with no URL. `EXCALIDRAW_ISSUE_AGENT_TIMEOUT` and
`EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT` (both in seconds) put a ceiling back for anyone who
wants one.

A killed run was supposed to be survivable: on timeout the run salvages a URL from whatever
the agent printed, so a slow success is not reported as a failure. **That is not a guarantee,
and it was documented as one.** The configured command is `claude -p` with no
`--output-format stream-json`, so its stdout arrives only at process exit — at the kill there
is nothing to read. The salvage is kept because it does work for a command that streams, but
what stops the trap is the ceiling not firing.

The ceiling was not decoration, though — its job was that a wedged run could not hold a block
in `running` forever. With it gone, that guarantee comes from the card instead. A running
block offers **Reset — the run was lost**:

- `DELETE /api/issue-block/:id` clears a stuck research run — `issueState` and `issueError`.
  The issue it produced, if it got that far, is left alone, which is what stops a reset
  becoming a second issue for one observation: `POST` still refuses a block that has an
  `issueUrl`.
- `DELETE /api/issue-block/:id/implement`, and `DELETE /api/implement` for a mirrored card,
  clear a stuck implementation.

Either reset clears state; neither stops an agent. Nothing here can reach into a process the
server no longer owns, and a button that claimed to would be lying. What they do is refuse —
409 — while a run is in flight *in this process*, which is the case that matters: the state
on the element cannot tell a live run from an abandoned one, and the server can. In-flight
runs are tracked in memory, so a restart is precisely when a `running` element has no run
behind it and the reset is the only way out.

### How long it has been running

Removing the ceiling left the panel saying one thing and holding it — *"An agent is
implementing this issue in the project. There is no time limit on the run."* — for however
long the run took, which on a real one is an hour or more of a panel that never changes.
Nothing was wrong; there was simply no way to tell that from wedged. A clock is the number
that sentence was missing.

`ImplementRecord` carries `startedAt` and `endedAt`, ISO, written once each: at the start,
and when the run settles as `done` or `failed` alike. `GET /api/implement?url=...` returns
them with the rest of the record, and `implementStartedAt` / `implementEndedAt` go onto every
element carrying the issue, so a block reads correctly with nothing selected and no network.

**Two instants, not a duration, and that is the design rather than a detail.** A duration
kept on the server would have to be rewritten to stay true, and every write to an element
bumps its `version` and broadcasts it — the bookkeeping behind `docs/trap-export-noise.md`.
A clock ticking once a second would therefore churn every running block, and every export
with it. So the server writes an instant that stays true for the whole run, and the browser
does the subtraction: `RunClock` in `DocsPanel.tsx` re-renders on its own timer and touches
nothing. A finished run has `endedAt`, so there is nothing left to tick and the total freezes.

`scripts/check-implement-progress.mjs` asserts that directly — it watches an element's
`version` across several seconds of real time and requires it to stand still while the elapsed
time derived from `startedAt` advances. `scripts/check-implement-progress-browser.mjs` does
the half only a browser can answer: that the number on screen moves with no reload and no
click.

### What the run is spending, when the agent says

Token counts are **opt-in**, and the reason is not effort. `EXCALIDRAW_IMPLEMENT_AGENT` is a
full command line set by whoever starts the board; nothing requires it to be Claude Code, and
a plain `claude -p` prints prose at exit and no figures at all. Usage can only come from the
agent reporting it in a machine-readable stream, which the operator's command line has to ask
for.

So the server looks for `--output-format stream-json` in the configured command
(`streamsUsage`, `src/core/agent-usage.ts`). Without it nothing is parsed, nothing is
recorded, no figures appear, and the spawn path is byte for byte what it was — the same
"nothing at all" half that `worktreeSection` and `imageReferenceSection` are careful about.
The prompt is not touched either: whether an agent reports usage is a property of the command
line, so there is nothing worth telling the agent. **The server never appends the flag
itself** — silently rewriting somebody's command line is a decision, not a lookup.

With it, stdout is read line by line as it arrives and the totals go onto the record, not onto
the elements: they change throughout a run, so writing them to shapes would churn the board
through the other door. The panel picks them up on the poll it already makes every four
seconds, and gets one last read when a run settles under the reader's eyes — the ending
arrives over the socket as an element update, which carries the state but not the figures.

Three things about the parsing were confirmed against the CLI rather than inferred, and each
is a way the naive version is wrong:

- **The same message arrives more than once**, streaming and then finished, carrying one id
  and a usage block that has grown. Totals are kept per message id and the last one wins;
  adding up every event roughly doubles them.
- **The streamed figures are not final.** Output lags in particular — a message can stream at
  four output tokens and settle at thirty-nine. The `result` event carries the run's own
  accounting, so when it arrives it replaces the running sum rather than adding to it.
- **Input counts the cache.** `input_tokens` alone is a handful of tokens per message once
  prompt caching is on, with tens of thousands in `cache_read_input_tokens` beside it, so a
  panel showing the literal field would read as "this agent has consumed nothing" for an hour.
  What is shown is what the model was given: fresh input, cache writes and cache reads
  together.

`extractGithubUrl` runs over raw stdout, which is now NDJSON with the URL inside a JSON
string. That still works and is asserted rather than assumed.

Not covered: the research agent. It shares `runAgent` and would get both halves cheaply, but
its block has no surface to show them on.

## Configuration

```
EXCALIDRAW_ISSUE_AGENT='C:/Users/vtr_d/.local/bin/claude.exe -p --model claude-opus-5[1m] --effort high --allowedTools "Bash(gh:*) Bash(git:*) Read Grep Glob WebFetch WebSearch"'
EXCALIDRAW_IMPLEMENT_CONCURRENCY=4
EXCALIDRAW_ISSUE_MEMO_MS=30000
```

`EXCALIDRAW_ISSUE_AGENT_TIMEOUT=1200` used to be here, and pinning it in the environment is
how the twenty minutes outlived the code default. **Whatever starts the board sets these
variables and lives outside this repository** — `start-board.ps1`, per `HANDOFF.md` — so a
board still exporting a ceiling keeps it until that file is edited by hand.

**Pin the model and the effort.** Without `--model` and `--effort` the agent inherits whatever
`~/.claude/settings.json` happens to say, so changing the model of an interactive session
silently changes who writes the issues — and that is not a change anyone would think to look for
when an issue comes out worse than usual. The `[1m]` suffix selects the 1M-context variant.

`--allowedTools` is mandatory. In `-p` mode the agent investigates fine, but any command needing
approval is blocked, so it finishes with exit code 0 and no issue at all. The list is narrow on
purpose — `gh`, `git`, and reading. No `Write`, no `Edit`, no open `Bash`: the agent opens
issues, it does not touch the repository.

**`WebFetch` and `WebSearch` are part of reading.** The prompt has always ordered the agent to
research what the repository does not settle — "research it — do not invent it" — and until
these were added, the list denied it the only tools that do. `-p` turns that omission into a
silent refusal: the run gets `Claude requested permissions to use WebFetch, but you haven't
granted it yet`, exits 0, and reads afterwards as an agent that chose not to look anything up.
Both halves of that were observed rather than reasoned about: under the old list both calls are
refused, under this one both succeed, and **the exit code is 0 either way**. The narrowness this
does not weaken is the narrowness about *writes* — a read-only fetch adds nothing to what the
agent can change.

Unrestricted on purpose, not by omission. `WebFetch(domain:host)` is the documented way to scope
it — `WebFetch(domain:*.example.com)` for subdomains, a bare `WebFetch` for every domain — and an
allowlist of documentation hosts is the more conservative setting. It is not the default here
because it reinstates exactly this defect for anything off the list: an agent that needs a page
on a host nobody predicted is refused silently and exits 0. Scope it if the trade is worth it —
a fetch is read-only but can still carry repository content outward in the URL it requests.

**Add `--output-format stream-json --verbose` to the implement command to get token counts.**
Nothing else turns them on, and nothing else is needed. It changes what the agent prints, not
what it does: the pull request URL is still found in the output, and the salvage a firing
ceiling depends on starts working, since stdout then arrives as the run goes rather than only
at exit. Leave it off and the run is timed but not counted, which is the default and is not a
degraded state.

A WSL-backed project runs through `wsl.exe --cd <innerPath>`, because the agent has to see the
repository the way `git` and `gh` inside that distro do.

### What is per-project, and what stays global

One board runs several projects, and until #82 every setting above applied to all of them: the
two command lines were module constants read once at startup, so retuning one project meant
editing `start-board.ps1` and restarting the board for every other project too.

A project's own `board.config.json` can now say three things per agent, under
`agents.issue` and `agents.implement` — see [workspaces.md](workspaces.md) for the shape:

| Setting | Per-project | Global |
| --- | --- | --- |
| `model` | `agents.<kind>.model` → appended as `--model` | `--model` in the command line |
| `effort` | `agents.<kind>.effort` → appended as `--effort` | `--effort` in the command line |
| time limit | `agents.<kind>.timeoutSeconds` | `EXCALIDRAW_ISSUE_AGENT_TIMEOUT`, `EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT` |
| the command itself | **never** | `EXCALIDRAW_ISSUE_AGENT`, `EXCALIDRAW_IMPLEMENT_AGENT` |
| `--allowedTools`, `--output-format` | **never** | the command line |
| concurrency, memo window | **never** | `EXCALIDRAW_IMPLEMENT_CONCURRENCY`, `EXCALIDRAW_ISSUE_MEMO_MS` |

**A project may retune what the operator granted; it may never grant it.** Agents stay off
unless the environment sets their command, which is why a command is not a field a project may
set at all — `board.config.json` lives inside a registered project, so a project that could
supply one would mean editing a JSON file to start an unattended agent with
`--dangerously-skip-permissions` on a board where nobody allowed one. The config surface refuses
an `agents.<kind>.command` by name rather than ignoring it.

The model and the effort are **appended** to the operator's command rather than substituted into
it, which works because the last flag is the one the CLI keeps — checked against the CLI rather
than assumed: `claude --model sonnet --model definitely-not-a-model -p hi` complains about the
second one. Nothing else in that command line is rewritten, which is the line `agent-usage.ts`
already draws about `--output-format`.

**A project that configures nothing spawns the command line it spawned before any of this
existed, byte for byte.** That is the same rule `worktreeSection` and `imageReferenceSection`
keep about the prompt, and `scripts/check-workspace-settings.mjs` asserts it against a stub agent
that reports its own argv.

Not done here, and deliberately: the multi-stage workflow the observation behind #82 sketched —
plan with one model, implement with another, review with a third. That is a new execution model
rather than a setting (the board spawns **once** per implementation, and `ImplementRecord` holds
one start, one end, one pull request), so it needs its own issue. Per-run resolution of model and
effort is its precondition, which is what landed here. The `ultracode` keyword belongs to that
issue too: it is not a CLI flag but a prompt-level opt-in, and the implement prompt is kept free
of per-project content on purpose.
