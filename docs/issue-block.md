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

### Nothing rewrites the block under the caret

An observation is typed over seconds or minutes, and the board is not still underneath it: the
socket delivers other people's shapes, a reconnect re-sends the whole scene, the terminal
reconciles its blocks every 250 ms, a pasted screenshot writes a field onto this very block.
Every one of those writes the scene through `convertToExcalidrawElements`, which **deep-clones
the container and rebuilds its bound label**. Excalidraw grows a container by mutating it in
place and never replaces one whose label is being edited — so a container that is a different
object mid-keystroke was replaced by this page, and the open editor re-derives the live
textarea from whatever landed. #132 taught the two writers that reflow the notes column to
leave it alone; #190 found the other fourteen.

**So the rule sits in the one funnel they all go through** (`applySceneUpdateWithoutAutoSync`),
not at each call site: the container being edited and the label bound to it are put back into
any outgoing scene *by object identity*. It only ever substitutes, never adds — an element the
write left out stays left out, which is what keeps a deleted shape deleted and a board switch a
board switch.

**A remote update for the edited block itself is dropped, not deferred.** Deferring it would
mean replaying, when the caret leaves, a copy of the label captured while somebody was typing
into it — overwriting the sentence they just finished with the one the server last heard about.
The reader holds the authority for as long as the caret is theirs, and the autosync carries
what they wrote out the moment it is released. Everything else in the same write still lands
immediately, so a state change on another block is not held up by somebody typing.

### The block fits what is written into it

The library ships a 400x140 block and nothing in the browser ever made that height follow the
text. It was on loan from Excalidraw's editor-only auto-grow, and any rebuild handed it back —
after which `recenterBoundShapeTextElements` centres a 220px label in a 140px box and puts half
the overflow **above** the block. That is the second symptom in #190: past a certain length the
first lines stop being shown.

So a container is grown to the label bound to it — `label.height + 2 x BOUND_TEXT_PADDING`, the
same arithmetic `layoutLabel().containerHeight` does for `applyIssueToBlock` on the server. It
is applied from the *measured* height rather than the estimate, because a label already on the
canvas has been measured by the browser and `layoutLabel` exists for the server, which cannot
measure. **It only ever grows**: a short observation keeps the template height it was placed
with, and nothing on the board is made smaller by a measurement.

`scripts/check-issue-block-typing-browser.mjs` covers both, in a real Chrome, against the
label's `text` — the wrapped copy the canvas paints — and not only `originalText`, which is
what the editor holds. A rebuild that re-derives one from a stale copy of the other looks
perfect to a check that reads only the second.

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

### The attachment is not read back to the page that made it

Attaching writes the list onto the block with one `PUT /api/elements/:id`, and that write used
to come straight back to its own author as an `element_updated` carrying the server's **whole
copy** of the block, merged over the live scene field by field. Through a burst of typing the
autosync is a debounce behind, so that copy is the block as it was before it grew — which is
how pasting a screenshot became one of the things that could take an observation apart around
the caret (#190).

A page's socket and a page's HTTP writes are two connections and nothing tied them together, so
now the socket names itself on connect (`?client=<id>`) and a write names the same id in
`x-client-id`. Same id, no echo. **An id no socket answers to excludes nobody**, so a client
that never names itself — the MCP server, a script, any other tool — is told everything, as
everything was before this existed. The author applies *what it wrote* to its own scene instead,
which is a field on one element rather than a rebuild of the board; the response carries the
whole updated element, so it is never left guessing what the server made of the request.

`scripts/check-issue-block-typing.mjs` asserts the sender is not told and a second browser on
the same board still is.

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
**Add observations** and **Recreate with observations** are what a created block gets instead:
the first appends to the issue, the second sends an agent back at it. Neither takes images —
the file store is in memory and the block holding `customData.issueImages` is gone by the time a
card exists, so a recreate starts with none. A screenshot is often exactly what a first
investigation was missing, and that is worth an issue of its own rather than a guess here.

## What a block looks like

A block used to look the same at every stage. `draft`, `running`, `created` and `failed` were
four states with one appearance, because appearance was authored once in
`docs/blocks.excalidrawlib` and only ever copied afterwards — no code owned the question.
`src/core/issue-appearance.ts` owns it now, as one pure function from state to colours.

| Stage | Outline | Stroke | Fill |
| --- | --- | --- | --- |
| `draft`, `running`, `failed` | dashed | `#1971c2` | `#e7f5ff` |
| `created` | solid | `#1864ab` | `#d0ebff` |

**Dashed means there is no issue behind it yet; solid means there is.** The second stage is the
first one step down the same ramp rather than a new colour, so a board reads as one thing at a
glance and the change still survives being squinted at.

**The ramp is the notes column's, and that is the point.** A block is only ever written in one
place — the column the canvas draws for itself — and on the mirror hue means *the column*
(`docs/project-board.md`). Under a blue header a yellow block read as a mistake (#195), because
the header and the blocks under it are one population to look at. `#1971c2` is the header's own
stroke and `#e7f5ff` the tint that column computes for cards it can never hold; the second stage
is the blue rung matching the yellow one this used to be. A block dragged in from the library
gets the same look, having no column of its own: one kind of shape with two appearances
depending on how it was made would be worse than the disagreement this replaced.
`check-notes-block-hue.mjs` reads the header's stroke out of the layout rather than retyping it,
so the block and the bar above it cannot drift apart.

A block on a board saved before that change comes back in the new hue rather than the one it was
exported in: `seedableElement` repaints every block it reads, the look being the server's. It is
the one place a look arrives from outside this process, and nothing else on the way in writes a
block's colours.

`running` and `failed` deliberately keep the first-stage look. Both are blocks with no issue
behind them, which is exactly what the dashed outline already says, and the panel reports which
of the two a block is in. `check-block-appearance.mjs` holds the draft values against the ones
the library ships: a mapping that disagreed with the library would repaint every block the first
time anything touched it.

The appearance is written by the server, in the same `markIssueState` that writes
`customData.issueState`, rather than derived in the browser. That is where the state is
authored, so the look persists, exports with the board, and reaches every connected tab on the
update that already carries the state — a browser deriving it on render would have to derive it
again on every path that draws a block, and a block saved to `docs/board.excalidraw` would go
back to looking like a draft.

### The state is the server's, and the sync is told so

Authored on the server was not, on its own, enough to keep it there. `POST /api/elements/sync`
merges whole elements by `version`, and `version` is the browser's number — bumped on every
keystroke and nudge, against one bump per state change here. So a browser payload built before
a run's write and applied after it took the block back to the draft it was, and three blocks
that produced #94, #95 and #96 kept no record of having done so: no `issueState`, no
`issueUrl`, a dashed outline, nothing able to retire them and nothing able to run them again
without opening a second issue.

`src/core/element-authorship.ts` names the fields this file writes, and the sync restores them
onto any payload that disagrees rather than letting a version number decide them.
[sync-reconciliation.md](sync-reconciliation.md) has the measurement and the rule in both
directions.

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
`EXCALIDRAW_GH_COMMAND` overrides the binary so `scripts/check-issue-detail.mjs` can stub it —
and `ghCommandFor` resolves it per workspace, because this route builds its own command line
rather than going through `runGh` and was therefore the second place a host path reached a
distro ([trap-gh-path.md](trap-gh-path.md#it-is-two-machines-and-two-binaries)).

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
selection is served), `recordImplement`, because a run ends in a pull request and a pull request
is what closes an issue, and a recreate landing, which has rewritten the body outright. The panel
writes the same actions through to its own cache — and for the recreate it *drops* its entry
rather than patching it, because what it is holding is the issue the run replaced.

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

A created block's panel offers **Add observations** on the action row. It opens a box, and what
is typed there is posted to the issue as a GitHub comment by `POST /api/issue/comment`. The
comments are read back with the issue and shown under its body.

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

## Researching it again

A comment can only append, and that rule is exactly what makes a *wrong* issue permanent. When
the first investigation went the wrong way — wrong root cause, wrong file cited, a scope that
misses the point — the body stays wrong, and the reader it is wrong at is an unattended coding
agent. The rule above is the evidence: the implement agent is asked to reconcile two texts that
contradict each other, when what was wanted was one text that is right.

So a shape standing for an issue **nothing has been started on** also offers **Recreate with
observations**. It opens a box of its own, and confirming starts an agent through
`POST /api/issue/recreate` with `{ url, observations }`.

**It rewrites the issue; it does not replace it.** The number, the project card, the column, the
comments and everything the server keys on the URL — the memo, the implement record, the queue's
"one record per issue" rule — all stay valid, and nothing downstream has to learn a new fact.
Closing the old issue and opening a new one would abandon the card in Todo, leave a closed
duplicate on the board, and point every one of those at a dead issue.

### The Todo gate

The control is offered, and the route only answers, while the issue is **open, in the Todo
column, with no implement record against it**. Each is a refusal the route names:

| Refused | Because |
| --- | --- |
| the issue is closed | it is shipped or abandoned; there is nothing left to research |
| its card is not in Todo | past Todo, something has been built against it |
| its card is not on the project | there is no column it could be waiting in |
| an implement record exists — `running`, `done`, `failed` or `interrupted` | an agent has already read this issue |
| a recreate is already in flight for the URL | the same guard the research run has |

Todo is not cosmetic and it is not "not started yet" in a looser sense: it is the workspace's own
`projectTodoColumn`, matched trimmed and without regard to case, and it is where a finished
research run already puts the issue it created. Past it, rewriting a body would change the
specification behind a running agent's back — the same hazard **Add observations** already names,
except that a comment cannot silently replace what the agent read and a rewrite can.

A board with **no project** has no column, so there is nothing to gate on and no project is read:
a dormant board stays as dormant as it was. That is also the case the *authored block* is covered
for. On a board with a project, `reconcileDrafts` retires a block as soon as the mirror draws a
card for its issue, so the surface this is offered on is almost always the card.

**The panel gates on a mark, not on a label.** `readProjectBoard` puts the workspace's Todo
column name on the board it returns, `layoutBoard` stamps `customData.inTodo` on the cards drawn
in it, and `resolvePanelTarget` carries that through to `IssueTargetData.recreatable`. Reading
the gate out of a column header's text would be reading a string that wraps and carries a count.

### What the run does

1. **The observations are posted to the issue as a comment, first.** A body that changed with
   nothing on the issue explaining why is a body nobody can review — and a run that dies having
   posted this leaves the reader exactly where **Add observations** would have, rather than
   losing what they typed. On stdin and never in argv, for the reason the comment route already
   is. It is best-effort: `gh` dropping a socket must not cost the rewrite.
2. **`ISSUE_REVISE_PROMPT` sends the agent at the issue**, not at a blank page. It reads the
   issue and its comments, treats the new observations as the later word, investigates the
   repository again rather than inheriting a conclusion because it is already written down, and
   rewrites the body — and the title, when the re-investigation changed what the issue is about
   — with `gh issue edit <url> --body-file -`. It is told not to run `gh issue create`, not to
   close the issue and not to delete its comments.
3. **The answer is the same URL.** A run is read as successful from the issue URL it prints, the
   way researching is; here there is one right answer, and an agent that named a different issue
   opened one instead of rewriting this one. That is recorded as a failure.
4. **Both caches are dropped when the run lands** — `issueMemo` on the server and
   `frontend/src/issue-cache.ts` in the browser — and the panel reads the issue again. Without
   that the reader would be shown the body the run replaced for up to thirty seconds.

The original observation is **not** an input: it was deleted with the block when the card
appeared. The current body is what the run starts from, which is why the prompt tells the agent
to read it and then not to trust it.

The run's state lives in memory against the workspace and the URL, and `GET
/api/issue/recreate?url=` is what the panel polls — a card has no element for a socket to update
and no `issueState` to hold `running`. It is forgotten on a restart, which is honest: the edit an
agent makes is a single call that either happened or did not, so there is nothing half-written to
recover. Only the panel that started a run reports its ending; a card selected an hour later is
not still announcing one.

Guarded like the research run rather than like the comment route, because it spawns an agent:
`EXCALIDRAW_ISSUE_AGENT` set or the route 404s, loopback or it 403s.

**`POST /api/issue-block/:id` is untouched.** It still answers 409 for any block carrying an
`issueUrl`, and `DELETE /api/issue-block/:id` still puts such a block back to `created` rather
than making it runnable. Recreating is a route of its own precisely so that the "one observation,
one issue" guard did not have to be relaxed — this one opens no issue at all.

`scripts/check-issue-recreate.mjs` covers the route, the prompt and every refusal against a stub
`gh` and a stub agent; `scripts/check-issue-recreate-browser.mjs` covers the control, the box and
the body arriving on screen with no reselection.

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
from its surroundings. Nothing in the prompt said otherwise. Now it names the language outright.

**Which language is the project's to say, and English is what it says when the project says
nothing.** Fixing the language was right; fixing it to one was not. This board opens issues in
more than one repository, and a project whose own conventions require Portuguese was getting
every card this tool opened for it written against its own rule — a collision, not a taste. So
`board.config.json` carries a `language` ([workspaces.md](workspaces.md#boardconfigjson)) and
the paragraph names it. Everything else about the rule is unchanged, and deliberately so: the
language is still *fixed* rather than inferred, the agent still may not take it from the
observation or from the repository it just read, and an observation whose exact wording is the
evidence is still quoted rather than translated. A project that sets nothing gets the prompt
byte for byte as it was.

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
EXCALIDRAW_IMPLEMENT_AGENT='<agent-binary> -p --model claude-opus-5[1m] --effort high --dangerously-skip-permissions'
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

### A run is something you can watch

With `EXCALIDRAW_TERMINAL` also set, starting a run opens a **terminal session of its own** in
the worktree of that run, and a tab appears on the board without anyone clicking for one. It is
labelled with the issue — `#128`, not `s4` — because a tab that arrives on its own beside three
shells the reader opened has to say what it is. The agent's output arrives on it as the agent
writes it, which is what a block saying `running` and nothing else could never do.
`GET /api/implement` names the session in `terminal`.

The tab is for **watching**, not for typing into: stdin is where the prompt went, and it was
closed behind it. `docs/terminal.md` has the measurement that rules the alternative out.

**The two switches stay independent, and the run never depends on the tab.** With no terminal,
with no PTY binding, or with all eight tabs already taken, the implementation runs in a private
child exactly as it did before any of this existed and settles the same way; `terminal` is
`null`, and nothing anywhere answers 404 or 409 on account of the run.

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

The same write, one step earlier. A block is drafted in the notes column, which is the canvas's
own and not on the project at all, and the issue the agent creates arrives wherever the project's
*Item added to project* workflow puts it — a decision this code cannot read. Once the issue exists
it is no longer an observation waiting to be looked at, so the server moves it to **Todo** rather
than leaving it wherever that workflow chose.

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

### The queue, which defers instead of refusing

The cap refuses: the fourth click works, the fifth is told to come back later, and coming back
later is a person watching the board. `POST /api/implement/queue` with `{ "enabled": true }`
turns that into a deferral — the server then starts the **oldest** issue in **Todo** every time a
slot frees, until the column runs out. The circular arrow on the Todo header is the same switch;
`docs/project-board.md` has the button.

What it starts and what it passes over:

- the column is read **uncapped**, so the queue works from the whole of Todo rather than from the
  handful of cards `projectCardLimit` happens to draw;
- **oldest first**, by `createdAt`, with the issue number only as a tiebreak — cards can come
  from other repositories and draft items have no number;
- a card is skipped when it is not an issue, when the issue is closed, when it belongs to another
  repository, or when this workspace already has **any** record against it. `done` and `failed`
  are records: the queue tries each issue once and never retries, so a backlog cannot be burnt
  against a build that is broken. Restarting one is a click, which is where the decision belongs.

Every start goes through the same `POST /api/implement` a click does, so the cap is enforced in
the same place — the claim made before the first `await` — and a `409` is read as *not yet*.
The queue and a click racing for the last slot is therefore a race one of them simply loses.

**On the server, not in the browser.** The mirror's twenty-second poll is gated on tab
visibility on purpose, and a queue that stopped advancing whenever the tab was hidden would stop
during exactly the hours it is worth having. A run settling dispatches directly; a timer
(`EXCALIDRAW_IMPLEMENT_QUEUE_MS`, default 30s) covers the changes this process cannot see, such
as a card dragged into Todo on GitHub. The timer does not exist until some workspace turns its
queue on, because a board nobody switched on must cost no `gh` at all.

**Per workspace, in memory, off after a restart** — the same place the cap and the run registry
live. This switch spawns coding agents against a repository, so a server that came back up and
resumed starting runs would be acting on a decision made before whatever brought it down.
Resuming the runs a restart *lost* is a different question, and is answered under "A run that
lost its server".

`scripts/check-implement-queue.mjs` covers the draining and
`scripts/check-implement-queue-browser.mjs` the button.

### A run that lost its server

State lives in a `Map`, so a restart empties it — and until this, a run killed with its server
came back as *nothing*. The board said nothing had gone wrong: the cards sat in **In Progress**,
exactly where a healthy run puts them, while `GET /api/implement` on the restarted process
answered `0 runs recorded`. One of the worktrees held eleven modified files and no commits at
all — 377 lines that existed only as a dirty working tree, held by nobody — and the only control
the panel offered was **Implement / Fix**, which would have put a fresh agent in a directory full
of changes it did not write, with nothing telling it they were there.

**The fact is derived rather than kept.** At startup the server reads the worktrees:
`src/core/implement-recovery.ts` walks `git worktree list`, keeps the `issue-<n>` checkouts under
the project's own worktree root, and reports any with commits the base branch does not have or a
dirty tree. Those become `ImplementRecord`s in state `interrupted`, with the checkout's path and
its counts. Nothing is written to disk. A file could be written and never cleaned, or cleaned and
never written; the worktree *is* the work, so it cannot disagree with itself — and it is true even
for a run the server never got round to recording. A clean checkout with nothing ahead is not
reported, which is the right answer rather than a gap: there is nothing in it to resume.

The issue URL is reconstructed from the checkout name and the repository — `repo` in
`board.config.json` first, then `origin` — because `issue-49` is only half of an issue URL. A
board that declares neither gets a warning and no records rather than a URL pointing at somebody
else's issue.

**Two things this deliberately does not do.** It does not commit on anyone's behalf: a commit
nobody wrote, with a message claiming nothing, is a commit somebody has to interpret later. And it
does not move the card. A stranded `In Progress` card is wrong, but a card that walks backwards on
its own while a person is looking at the board is worse — and the argument for the server writing
the moves in the first place, that the agent is the one participant that cannot report its own
crash, says nothing about who undoes a move when the *server* is what crashed.

The price of deriving is that it cannot say *when* a run started, and cannot tell a run that was
killed from one that finished and left a dirty checkout behind. Both read as "there is work here
that nobody is doing", which is the question being asked. So a run whose pull request was merged
while its worktree stayed dirty comes back as `interrupted` after a restart. `DELETE
/api/implement` clears the record, but the next startup finds the worktree again — the way to
settle it is to finish or discard what is in the checkout, and the panel says so.

### Resuming one

An `interrupted` run offers **Resume** in the panel, beside **Implement / Fix** rather than
instead of it: continuing somebody else's half-finished change and throwing it away and starting
again are both defensible, and they have to stay two decisions. `POST /api/implement` takes
`resume: true`, and refuses with 409 unless the server agrees there is an interrupted run to
continue — so a resume can never quietly become a fresh run over work nobody read. Everything else
is the run that already existed: the same per-issue guard, the same cap, the same worktree, which
`ensureWorktree` reuses because the checkout is named after the issue.

What changes is a paragraph of the prompt. The agent is told that a previous attempt ran in this
same checkout, that its process died rather than it giving up, how much it left — commits ahead
and uncommitted paths — and that none of it was reviewed, verified or explained. Then it is told
to read it (`git status`, `git diff`, `git log` against the default branch) and to decide whether
to build on it or discard it, saying which in the pull request.

**Resuming the previous agent's own session would be better and is not what this does.** Claude
Code's `--resume <session-id>` composes with `-p`, and a transcript holds what an agent had
decided and already ruled out, which no diff reconstructs. The obstacle is where the id could
live: detection here persists nothing, and a session id is not in the worktree, so carrying one
across a restart means a file on disk — the persistence this deliberately does without. It would
also mean the server appending flags to a command line somebody else wrote and assuming that
command is Claude Code, which is the same rewrite the token counting refuses to make for
`--output-format`. If the session id ever does get a home that survives a restart, the two
compose: resume the session *and* keep the paragraph, for the case where the session is gone and
the worktree is not.

`scripts/check-implement-resume.mjs` kills a server mid-run and asserts the restarted one reports
the run as interrupted rather than as absent, that a checkout with nothing in it is reported as
nothing, that Resume is refused for anything that is not interrupted, and that resuming does not
become a second run. `scripts/check-implement-resume-browser.mjs` does the half that only a
browser can answer: that the button is on screen for an interrupted run, absent for an untouched
one, and that clicking it continues in the same checkout.

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

- `DELETE /api/issue-block/:id` clears a stuck research run — `issueState`, `issueError`, and
  the two instants its clock was counting from. The issue it produced, if it got that far, is
  left alone, which is what stops a reset becoming a second issue for one observation: `POST`
  still refuses a block that has an `issueUrl`.
- `DELETE /api/issue-block/:id/implement`, and `DELETE /api/implement` for a mirrored card,
  clear a stuck implementation.

Either reset clears state; neither stops an agent. Nothing here can reach into a process the
server no longer owns, and a button that claimed to would be lying. What they do is refuse —
409 — while a run is in flight *in this process*, which is the case that matters: the state
on the element cannot tell a live run from an abandoned one, and the server can. In-flight
runs are tracked in memory, so a restart is precisely when a `running` element has no run
behind it and the reset is the only way out.

### And the way back from a run that lost its answer

A reset is for a block stuck in `running`. The block #118 leaves behind is stuck in nothing —
it carries no `issueState` at all, so the reset does not apply, and no `issueUrl`, so the run
button is offered and would open a **second** issue for an observation that already has one.
Deleting the block by hand was the only answer, and it takes the observation with it.

So the block is told the answer instead. Its panel carries **This block already has an issue**
beside the run, and what is typed into it goes to `POST /api/issue-block/:id/adopt`. That route
reads the issue through `gh` and then makes exactly the writes the end of a successful run
makes, so the block comes out indistinguishable from one whose result was recorded properly:
`reconcileDrafts` can retire it, the panel renders the issue, and `POST` refuses it a run.

Four things bound it.

- **It creates nothing.** The URL names an issue that already exists and the route reads it;
  a URL `gh` cannot answer for is a 502 and nothing is written. That is what stops this being
  a way to put an arbitrary URL on a block and have the board believe it.
- **A block that already has an issue is refused**, 409, rather than repointed. Losing the
  first one silently is worse than making somebody reset it first.
- **Guarded like the read route, not the run route.** It starts no agent and touches no
  repository, but it does spawn a process holding your `gh` credentials, so loopback only.
- **It is worded as a fact, not an action.** *This block already has an issue* — the wrong
  reading of it, "make an issue for this", is the button directly above it.

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

Covered for the research agent too, and the section below is where that differs.

#### How much of `out` was thinking

`28.4k out` cannot distinguish an agent that wrote a long answer from one that thought for a
long time and said little, and on a reasoning model the second is the usual case. The
reasoning tokens were never missing from that figure — they are billed as output and have
always been inside it — so what the panel gained is the **split**, not a fourth total:
`28.4k out (12.1k thinking)`, in brackets because a third `·` segment reads as something to
add to the other two.

Where the figure comes from was the whole question, and the answer is not where the Messages
API puts it. That reference documents `output_tokens_details.thinking_tokens` as a read-only
decomposition of `output_tokens` — but `claude -p --output-format stream-json --verbose`
(checked against 2.1.220) **never sends it**: not on an assistant message, not on `result`.
Parsing only that field would have produced a feature that is always absent, which is why the
CLI was run before the parsing was written rather than after.

What the CLI sends instead is an event of its own:

```json
{"type":"system","subtype":"thinking_tokens","estimated_tokens":150,"estimated_tokens_delta":100}
```

Two properties of it decide the implementation, and both were observed rather than assumed:

- **`estimated_tokens` restarts at every assistant turn** — 50 → 150 → 173 for one turn, then
  50 → 129 for the next. It is the turn's total, never the run's, so reading it at face value
  makes a run's reasoning go *backwards*. The deltas are what accumulate.
- **`result` says nothing about reasoning.** Unlike input and output, the figure has no
  settled counterpart, so it is kept *beside* the settled totals rather than inside them. Fold
  it in and the split shows for the length of the run and then vanishes at the moment the run
  is finished and worth reading.

Both shapes are read, because `EXCALIDRAW_IMPLEMENT_AGENT` is somebody else's command line and
need not be Claude Code: a breakdown inside `usage` wins where an agent reports one, and the
summed estimate fills the silence otherwise. Nothing emits both, so it is a choice rather than
a merge — which is also what stops anything being counted twice.

**Null, not zero, when neither arrives.** An agent that reports no breakdown has not claimed
its reasoning was nothing, and `0 thinking` is an answer where silence is the truth — the same
distinction `reported` is careful about one field over. The panel shows the clause only when
there is a number, so a run with in and out alone reads exactly as it did before.

The figure is the agent's own estimate and is labelled as one in the panel's tooltip.

**Mid-run it can read larger than the figure it is a share of** — a real run showed
`87k in · 72 out (93 thinking)` — and that is the streamed `output_tokens` lagging, the second
bullet above, not the reasoning being wrong. Reasoning arrives as a complete delta the moment
it is spent while output is still catching up, so the two are briefly inconsistent and the
`result` event settles it. Deliberately not clamped to `out`: the smaller number is the stale
one, and capping the honest figure to it would make both wrong instead of one of them late.

It also inherits the limit the two totals beside it already have: under `--output-format stream-json`
the CLI emits only subagent `tool_use` and `tool_result` blocks by default, so a run that
spawns subagents under-reports all three until `result` lands — and `result` settles input and
output while leaving reasoning at whatever the main thread reported. Worth an issue of its
own; `--forward-subagent-text` is where it would start.

### The same two halves, for the run that writes the issue

The paragraph above used to end *"Not covered: the research agent. It shares `runAgent` and
would get both halves cheaply, but its block has no surface to show them on."* The first clause
was right and the second had stopped being true: a `running` block does have a panel, and what
it showed was one fixed sentence — *"Researching the repository and drafting the issue. This
takes minutes, and there is no time limit on the run."* — that never changed for the length of
the investigation. Which is the complaint the clock was built for, one agent over.

So the design above transfers, unchanged where it can be and different only where the two runs
genuinely are:

- **The instants go on the block.** `issueStartedAt` at `markState('running')`, `issueEndedAt`
  when the run settles — on the `created` and the `failed` path alike, written by one `settle`
  rather than by three call sites, because a path that settled a block and forgot the instant
  would leave a total ticking forever. Both are in `SERVER_AUTHORED_CUSTOM_DATA`, so the #118
  sync race cannot drop them, and `RunClock` does the subtraction in the browser exactly as it
  does for an implementation. A block reads correctly with nothing selected and no network.
- **The figures go on a record, because there is nowhere else they can go.** A total that moves
  throughout a run cannot live on a shape without rewriting it every time it moves. The
  implement side keeps an `ImplementRecord` for this; a research run had only
  `issueRunsInFlight`, a bare `Set<string>` that could say *that* a run was in flight and
  nothing else. It is a map now — state, both instants, usage — and `runIssueAgent` passes
  `onUsage` through to the meter that was already there.
- **The panel polls `GET /api/issue-block/:id/run`** while the block is `running`, and reads it
  once more when it settles. Its own route rather than an extension of
  `GET /api/issue-block/:id/issue`, which is a different question: that one reads the issue from
  GitHub through `gh` and answers 404 for a block that has none, which is every block with a run
  in flight.
- **The record outlives the run.** That last read happens *after* the ending, because the ending
  arrives over the socket as an element update carrying the state and not the figures — so a
  record deleted when the run finished would lose the total at exactly the moment it became
  worth reading. `DELETE /api/issue-block/:id` is what clears one, and it takes the two instants
  off the block with it: a reset says the run was lost, and a clock left behind would be
  counting for nobody.

**Researching an issue again is the same seam**, so it is the same change: `runReviseAgent`
passes `onUsage` onto the `RecreateRecord`, which already held `startedAt` and `endedAt` and
already had a panel polling it every four seconds and discarding both. One `RunProgress` renders
all three runs — a second copy of it would be a second answer to *what is worth saying about a
run in flight*, and the first one to drift would be the one nobody was looking at.

Opt-in works out the same way it does above and for the same reason: the figures come from
`streamsUsage` reading the operator's own command line, so a board configured with a plain
`claude -p` gets a clock, no token figures, and the prompt and spawn it had before — asserted
rather than assumed, in `scripts/check-issue-progress.mjs`.
`scripts/check-issue-progress-browser.mjs` does the half only a browser can answer.

## Configuration

```
EXCALIDRAW_ISSUE_AGENT='<agent-binary> -p --model claude-opus-5[1m] --effort high --allowedTools "Bash(gh:*) Bash(git:*) Read Grep Glob WebFetch WebSearch"'
EXCALIDRAW_IMPLEMENT_CONCURRENCY=4
EXCALIDRAW_ISSUE_MEMO_MS=30000
```

`EXCALIDRAW_ISSUE_AGENT_TIMEOUT=1200` used to be here, and pinning it in the environment is
how the twenty minutes outlived the code default. **Whatever starts the board sets these
variables**, and it is the operator's, not this repository's — [running.md](running.md) is the
procedure and the full table of what it can set — so a board still exporting a ceiling keeps it
until that environment is edited by hand.

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

**Leave `-p` off the implement command and the run becomes something you can answer.** The
server reads the shape of what you wrote — `-p`/`--print`, the same way it reads
`--output-format stream-json` — and a command that does not say it is given a pseudoterminal and
its prompt as an argument rather than on stdin. The tab is then a real `claude` drawing its
interface, which is what the flag above otherwise turns into NDJSON, and what you type in the
block reaches it. Three things come off with the flag, and they are the trade:

- **the token counts**, because `--output-format` only works with `--print`;
- **the ending**, because a TUI goes back to its own prompt instead of exiting. The run settles
  when the session does — `/exit`, or the tab's `×` — and its exit code is not read, since a
  reader closing a tab is a kill. The pull request URL is taken from the transcript, which is
  what the prompt already orders the agent to print last;
- **unattended runs**, which follow from the second: with `EXCALIDRAW_IMPLEMENT_CONCURRENCY`
  draining a queue there is nobody to end anything, so those runs hold their blocks in `running`
  and their tab slots. Keep `-p` for a board that queues, and drop it for one you watch.

With the terminal off, with no PTY binding, or with `EXCALIDRAW_TERMINAL_PTY=0`, a command
without `-p` runs exactly as one with it — `docs/terminal.md` has the whole of it.

A WSL-backed project runs through `wsl.exe --cd <innerPath>`, because the agent has to see the
repository the way `git` and `gh` inside that distro do.

### What is per-project, and what stays global

One board runs several projects, and until #82 every setting above applied to all of them: the
two command lines were module constants read once at startup, so retuning one project meant
editing the board's own environment and restarting it for every other project too.

A project's own `board.config.json` can now say four things per agent, under
`agents.issue` and `agents.implement` — see [workspaces.md](workspaces.md) for the shape:

| Setting | Per-project | Global |
| --- | --- | --- |
| `model` | `agents.<kind>.model` → appended as `--model` | `--model` in the command line |
| `effort` | `agents.<kind>.effort` → appended as `--effort` | `--effort` in the command line |
| time limit | `agents.<kind>.timeoutSeconds` | `EXCALIDRAW_ISSUE_AGENT_TIMEOUT`, `EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT` |
| how the agent works | `agents.<kind>.workflow` → the text of `agent-workflows/<slug>.md`, last section of the prompt | the base prompt, which holds no project's conventions |
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
existed, byte for byte — and sends the same prompt, byte for byte.**  That is the same rule
`worktreeSection`, `imageReferenceSection` and `workflowSection` each keep, and
`scripts/check-workspace-settings.mjs` asserts both against a stub agent that reports its own
argv and the prompt it was handed.

### Saying how the agent works, without granting it anything

`agents.<kind>.workflow` names a slug; the text at `<project>/agent-workflows/<slug>.md` is read
and appended to the prompt as its **last** section. That is the one thing in this table which is
about how the agent *works* rather than how well it runs, and it exists because the base prompt
withholds a workflow on purpose — writing this repository's conventions into it would make the
feature wrong for every other board. What it says instead is "read your own project memory […]
and follow the workflow it records", which is a pointer: an agent may or may not follow it, a
fresh worktree may hold no memory behind it, and a typo in it fails as silence. A project that
runs a pipeline — plan on one model, review the plan, implement, review the implementation — had
no way to say so.

- **The text, not a pointer to it.** Authorization comes from the turn, and the prompt the board
  writes *is* that turn. There is no size cap: how big the file is, is a property of what the
  project wrote, and a cap that truncated silently would reinstate exactly the failure this
  exists to remove.
- **A slug, not a path**, matching `[a-z0-9][a-z0-9-]*`, so a name that does not resolve can be
  reported as one file. `/`, `..`, a drive letter and anything else are refused twice: by the
  slug shape, and again by `resolveInWorkspace` on the join.
- **At the project root and committed.** Not `CLAUDE.md`, which interactive runs load too, so a
  board-only pipeline would leak into every session opened by hand; not under `docsDir`, which is
  configurable and whose markdown becomes documentation cards; and not a dot-directory, which is
  the one shape a project has most likely gitignored already — it would resolve on the
  maintainer's checkout and be absent in every board run, since an implementation runs in a
  worktree cut from the default branch.
- **A name that does not resolve refuses the run before the spawn**, naming the file it looked
  for. Deliberately unlike the rest of a project's config, where a field pointing outside its
  project is [ignored and the workspace still loads](workspaces.md): a workflow silently not
  applied is a run that looks entirely normal and did the wrong thing, in a process nobody was
  watching.
- **It is not a capability.** Nothing from the file reaches argv, the environment,
  `--allowedTools` or `--dangerously-skip-permissions`, and the section says so to the agent in
  as many words. `scripts/check-agent-workflow.mjs` asserts the mechanical form of it: selecting
  a workflow changes the prompt and leaves the command line byte-identical to the one a project
  selecting nothing spawns. Nothing new has to be granted for a pipeline, either — the implement
  agent already runs with `--dangerously-skip-permissions` rather than an allowlist, and its
  prompt has always said "You may put helpers to work — sub-agents".

**On the issue side the field is shipped but inert**, and that is the operator's call rather than
this one's. The documented `EXCALIDRAW_ISSUE_AGENT` allowlist above — `Bash(gh:*) Bash(git:*)
Read Grep Glob WebFetch WebSearch` — has no sub-agent tool in it, and in `-p` mode a tool outside
the list is refused silently with exit 0 and no result. A workflow asking the issue agent to
orchestrate therefore does nothing until that variable is widened. The field is there for
symmetry, and because the same setting already covers both of that agent's runs, researching and
rewriting.

Orchestrated runs also **under-report their token totals while they run**, which was already
true and stops being theoretical now that a project can ask for orchestration: under
`--output-format stream-json` the CLI emits only sub-agent `tool_use`/`tool_result` blocks by
default, so all three figures settle only when `result` lands, and reasoning stays main-thread
only even then. `--forward-subagent-text` is where fixing that would start; it is its own issue.

Still not done here, and still deliberately: **the board spawns once per implementation.**
`ImplementRecord` holds one start, one end and one pull request, so a pipeline runs as
sub-agents inside that single run rather than as several runs the board sequences — the agent
orchestrates itself. A per-*card* workflow, chosen for one run rather than for the project, is a
separate issue too: the block would need somewhere to hold the choice and the run would need to
report which workflow it used.
