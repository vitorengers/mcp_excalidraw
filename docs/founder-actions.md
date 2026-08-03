# Founder actions

A founder action is the work only a person can do. Install something. Sign in. Approve a
permission. Pay a bill. The board can notice every one of these and can do none of them, and the
column it draws them in is for a reader who has a payment card and ten minutes — not for an
engineer.

That reader is the problem this page exists for. Everything else in this repository is written
for somebody who reads code: `docs/project-board.md` runs to hundreds of lines about queues and
worktrees, and an agent that has read it will write an engineering issue whatever a prompt asks
of it, because that is the register every example in front of it is written in. Asking more
politely does not work. So the opportunity is removed instead.

## The register is a schema, not advice

A founder action is **a record of named fields**, and `renderFounderAction` in
`src/core/founder-action-text.ts` is the only way to turn one into text. A producer that wants
to say something has to say it in a field, and every field is measured by
`validateFounderAction` before anything renders. There is no free-text slot in a founder action
and that is the whole design: a rule about a named field is countable, and "this does not sound
like a founder action" is the advice this module exists instead of.

The module is pure. It imports nothing, reads no file and starts no program, because the panel
that will draw these runs in a browser and `frontend/tsconfig.json` sets `"types": []` — a
single Node import here would fail the frontend type check in files nobody had touched.

Nothing here reads GitHub, the element store or the canvas. The register is enforced **at the
write**, never by inspection afterwards.

## The fields

| Field | Cap | What it answers |
|---|---|---|
| `title` | 60 characters, one line, no trailing full stop | The blocker, as a person would say it |
| `what` | 140 characters | What is the matter |
| `why` | 240 characters | Why no machine here can do it instead |
| `steps` | 2 to 7, each 120 characters and one sentence | What to go and do, in order |
| `confirm` | 160 characters | What they will see when it has worked |

Numbering is the composer's job. A step is written as a sentence; `renderFounderAction` puts the
`1.` in front of it, and takes off any ordinal a producer transcribed along with the text.

The kinds are a closed set — `gh-missing`, `gh-login`, `gh-scope`, `gh-credential`,
`gh-rate-limit`, `gh-billing`, `push-denied`, `agent-missing`, `agent-not-granted` and
`agent-usage-exhausted`. Closed, because a kind with no entry in the register has no
founder-readable text to draw, and inventing one at the point of failure is how prose comes
back.

## The rules

Every rule names one field, and every rule is a number somebody can argue with:

- every field carries something;
- `title` is at most 60 characters, on one line, and does not end in a full stop;
- `what` is at most 140 characters, `why` at most 240, `confirm` at most 160;
- there are between 2 and 7 steps, each at most 120 characters and each one sentence;
- where steps carry their own ordinals, those ordinals run `1..N` consecutively — a gap is a
  step that was dropped on the way in;
- the rendered record, with the evidence left out, is at most 1200 characters;
- no sentence anywhere runs past 25 words;
- no founder field carries machine noise: no HTTP status, no `Error:` at the head of a line, no
  path into `src/` or `scripts/`, and no line over 200 characters;
- no founder field uses an unexplained word from a closed list.

The per-field caps are generous on purpose and the 1200-character cap is what actually bites:
seven steps of 120 characters is 840 characters of steps alone, so a record that spends its whole
allowance everywhere cannot be rendered at all.

Addresses and backticked spans are exempt from the long-line rule and from the machine-noise
rule, because a step that says where to buy credit has to be able to name a page.

### The jargon list, and why it is short

The list is `OAuth`, `PAT`, `worktree`, `single-select`, `stderr` and `loopback` — words nothing
user-facing in this product writes today. It is short because **it has to exclude every word a
shipped remedy already uses**. The remedy in `gh.ts` for a missing permission says "scope"; the
one for a missing program says "CLI"; `pushRefusal` in `github-push.ts` says "repo". A list
carrying any of those would reject the best copy this product has, and the check holding it
would be deleted inside a month. So `scripts/check-founder-action-register.mjs` runs those three
shipped sentences through the jargon rule as inputs it must leave alone.

There are two escapes:

1. **a gloss where the word stands** — a parenthesis or a dash clause opening right after it, or
   a parenthesis closing right before it. Local rather than "somewhere in the sentence", because
   a sentence that explains itself two clauses later has already lost the reader at the word;
2. **backticks**, which mean a literal thing to type rather than a word to understand.

## Evidence is exempt from every rule

A founder action may carry evidence: the `command` that failed, what it `said`, and the `source`
in this tree that classified it. None of the rules apply to any of it.

That exemption is what lets the rules above stay tight. The jargon, the 300-character tail and
the HTTP status all have a legitimate home, so no producer is ever tempted to smuggle a stack
trace into `why` for want of anywhere else to put it. The split already exists one layer down:
`TerminalGhFailure` in `gh.ts` keeps `said` and `remedy` in separate fields, and the only reason
either ever reaches the canvas glued together is that its constructor joins them into `message`.

`renderFounderAction` puts `## Evidence` last, and leaves the heading out entirely when there is
no evidence — a heading that promises the reader something and then shows them nothing is worse
than no heading.

## The template

```markdown
# <title: the blocker as a person would say it, no full stop>

## What

<what: what is the matter, at most 140 characters>

## Why

<why: why no machine here can do it instead, at most 240 characters>

## Steps

1. <a step, one sentence>
2. <a step, one sentence>

## Confirm

<confirm: what they will see when it has worked>

## Evidence

- Command: `<the command that failed>`
- Said: <what it said, verbatim>
- Source: <where in this tree it was classified>
```

## The register

One worked entry per kind. Every block is `renderFounderAction`'s own output, and
`scripts/check-founder-action-register.mjs` asserts each one byte for byte — an example somebody
hand-edited is an example that teaches a shape the code does not produce.

None of the entries names an account, a repository or a machine: those are facts about one run,
and a run puts them in the evidence. The `push-denied` entry is shown with its evidence, against
an invented account called `octo-founder`.

### `gh-missing`

```markdown
# The GitHub CLI is not installed on this machine

## What

This board reaches GitHub through the GitHub CLI, and no such program is installed here yet.

## Why

Until it is installed the board cannot read your project, file an issue or start a run.

## Steps

1. Install the GitHub CLI from https://cli.github.com for this operating system.
2. Open a new terminal and run `gh --version` to see that it answers.
3. Start the board again so it picks up the program you just installed.

## Confirm

The board stops saying GitHub is out of reach, and your project cards fill in.
```

### `gh-login`

```markdown
# Sign the GitHub CLI in to your account

## What

The GitHub CLI is on this machine, but it is not signed in to any account yet.

## Why

Signed out, the board can show you nothing from GitHub and can start no run at all.

## Steps

1. Run `gh auth login` in a terminal and answer the questions it asks.
2. Choose the account that owns the project you want this board to show.

## Confirm

The board shows your project again instead of asking you to sign in.
```

### `gh-scope`

```markdown
# Let the GitHub CLI read your projects

## What

The sign-in is good, but it was never given permission to read GitHub projects.

## Why

A normal sign-in does not ask for that permission, so the project column stays empty.

## Steps

1. Run `gh auth refresh -s project` in a terminal.
2. Approve the request on the page it opens in your browser.

## Confirm

The project column fills in with the cards you see on GitHub.
```

### `gh-credential`

```markdown
# GitHub refused this sign-in, so make a new one

## What

GitHub turned down the sign-in this board is holding, so it is no longer any good.

## Why

A refused sign-in is usually one that was revoked or has run out, and nothing answers.

## Steps

1. Run `gh auth status` to see which account this board is using.
2. Run `gh auth login` and sign in again as that account.

## Confirm

The board reads your project again without asking you to sign in.
```

### `gh-rate-limit`

```markdown
# GitHub is asking this board to wait a while

## What

GitHub has answered this account more times than it allows for the moment.

## Why

The wait clears on its own and nothing is broken, but until it does nothing new arrives.

## Steps

1. Leave the board for an hour and let the wait clear on its own.
2. Run `gh api rate_limit` if you would like to see when it lifts.
3. Sign in as an account of your own if a shared one is doing this every day.

## Confirm

The project cards load again without a wait.
```

### `gh-billing`

```markdown
# GitHub is refusing work until billing is settled

## What

GitHub says this account owes a payment, and it is refusing the work the board asks for.

## Why

Nothing here can settle a bill, and every run is refused until the account is in good standing.

## Steps

1. Open https://github.com/settings/billing and read what it says is owed.
2. Add a payment method there, or fix the one already on the account.
3. Raise the spending limit on that page if it says the limit is what stopped you.

## Confirm

The billing page shows nothing owed, and a run starts instead of being refused.
```

### `push-denied`

```markdown
# This account may not push to the project repository

## What

The account this board is signed in as may read the repository, but it may not write to it.

## Why

A run has to push a branch and open a pull request, so it would fail with the work stranded.

## Steps

1. Fork the repository on GitHub so that you have a copy you own.
2. Point this project at your copy with `git remote set-url origin <your fork>`.
3. Run `gh auth status` to check which account the board is using.

## Confirm

A run starts and pushes its branch instead of being refused before it begins.

## Evidence

- Command: `gh api repos/octo-founder/pantry/collaborators/octo-founder/permission`
- Said: HTTP 403: Resource not accessible by personal access token
- Source: src/core/github-push.ts
```

### `agent-missing`

```markdown
# The coding agent is not installed on this machine

## What

This board hands the work to a coding agent, and no such program is installed here.

## Why

Without one a card can be filed on GitHub, but nothing can be built and no run can start.

## Steps

1. Install a coding agent this board supports, and sign in to it.
2. Run it once in a terminal to see that it answers you.
3. Point this board at it in the project settings dialog.

## Confirm

A run starts, and the agent begins writing in a block of its own.
```

### `agent-not-granted`

```markdown
# The coding agent has not been allowed to work yet

## What

The agent is installed, but it has not been allowed to change anything on this machine.

## Why

An agent that was never allowed reads the issue, refuses the first edit, and exits as a success.

## Steps

1. Run the agent once by hand in a terminal and accept what it asks you for.
2. Sign in to the agent with the account that carries your plan.
3. Start a run again from the board.

## Confirm

The agent writes files and opens a pull request instead of stopping early.
```

### `agent-usage-exhausted`

```markdown
# The coding agent has spent its plan for now

## What

The agent says this account has used what its plan allows for the window it is in.

## Why

Nothing here can add more, and every run is refused at once until the window comes round.

## Steps

1. Read the usage figure in the board header to see when the window resets.
2. Wait for that time, or raise the plan on the agent account page.
3. Start the run again once that figure has room in it.

## Confirm

The usage figure has room again, and a run begins instead of refusing.
```

## Which blockers the board notices, and which it may ask again about

The register above is the text. This is the other half: which conditions this product already
detects, what each one is called, and what the board may go and check for itself.

`src/core/founder-blockers.ts` reads what somebody else's probe answered and produces a
`FounderBlocker` — a kind, a stable key, and the evidence — or `null`. `founderActionFor` then
composes the founder action out of the corpus entry for that kind. `src/core/founder-verify.ts`
is the half that looks again. Both are pure: they spawn nothing, store nothing and file
nothing.

| Kind | Noticed by | One key per |
|---|---|---|
| `gh-missing` | the failure classifier, and the preflight independently | the board |
| `gh-login` | the same two | the board |
| `gh-scope` | the same two | the board |
| `gh-credential` | the failure classifier | the board |
| `gh-rate-limit` | the failure classifier, on a failure that is deliberately not terminal | the board |
| `gh-billing` | the failure classifier | the board |
| `push-denied` | `readPushAccess`, and only on a permission GitHub stated | repository |
| `agent-missing` | the agent preflight | role and environment |
| `agent-not-granted` | the agent preflight, where nothing was granted at all | role and environment |
| `agent-usage-exhausted` | one environment's limits reading | environment |

**One fact is one card.** A missing GitHub CLI is detected twice and independently — once off a
failing call and once off the startup preflight — so both produce the same key, and
`dedupeBlockers` keeps the first sighting with the evidence of whatever was being attempted.

### What a run knows, and where it goes

A corpus entry names no account, repository or machine on purpose. Five named holes are how the
facts of one run get in: the **repository**, the **permission**, the **binary**, the
**environment** and the **variable**. A repository name can be any length and a binary can be an
absolute path, so **an edit that would break a rule of the register is not made** — each one is
applied and then read by `validateFounderAction`, and kept only if the record still passes. A
board with a very long repository name gets the general sentence rather than a card that cannot
be drawn.

What a tool said never crosses into a founder field. `TerminalGhFailure` keeps `said` and
`remedy` in separate fields, and glues them into `message` only so that a `catch` reading
`.message` still carries the remedy — so nothing in this boundary reads `.message` at all.
`said` goes to `## Evidence`, where it is exempt from every rule; `remedy` picks the kind, whose
steps are already written for a reader.

### A probe that cannot say produces nothing

`readPushAccess` is deliberately permissive: only a permission GitHub explicitly stated as
non-pushing refuses a run, and every failure to learn is `unknown`. That rule generalises here,
because the alternative is a column that fills with cards about a bad network minute and a
reader who stops opening it.

- `verdict: 'unknown'` produces no blocker, and settles `cannot-say` when a card is looked at
  again — never satisfied, and never held against anybody.
- An environment the agent preflight could not probe produces nothing: a machine with no distro
  is not a machine with a missing agent.
- A limits reading older than ten minutes produces nothing. It means nobody has been in a
  session, not that a quota is still spent.

The full-access posture warning is **not** a blocker. It is human-only and actionable, and it
never blocks a run — a board works perfectly with it. Admit advice and the column fills with
advice.

### Looking again

`verifyAgainst(kind, snapshot)` answers `satisfied`, `still-blocked` or `cannot-say`, with one
line a person can read. Three kinds can only ever answer the third and say so: nothing this
board runs can confirm that a rate limit has lifted, that a bill has been paid or that a usage
window has room. Only the next call that goes through shows any of them, and this module makes
no calls at all.

## Naming the column per project

The column has a name, and the name is per project. `projectFounderColumn` in a project's
`board.config.json` says which of its columns this one is
([workspaces.md](workspaces.md#boardconfigjson)); unset, it is **`Founder Actions`**. That
default is this tool's own suggestion rather than one of GitHub's — no project GitHub creates
has such a column — but it is a default in exactly the same sense as the other two: a project
that already keeps one under a name of its own says so, and a project that has no such column
is told which key would name it rather than having one guessed for it.

`founderColumn(workspace)` in `src/core/project-board.ts` resolves it, and it returns the same
`ColumnTarget` shape as `todoColumn` and `inProgressColumn` — a name matched trimmed and
case-insensitively, plus the `board.config.json` key that would fix it. That shape is the whole
of column identity in this codebase; a founder column follows it or it is the constant
`project-board.ts` was written to avoid.

**A project may not point it at either of the other two, and that refusal is a correctness
requirement rather than tidiness.** The implement queue drains exactly one column, resolved by
name at dispatch time, and `findColumn` matches `trim().toLowerCase()`. A founder column with a
name of its own is therefore invisible to the start loop *by construction* — which is the
argument `scripts/check-founder-not-startable.mjs` holds — and that construction holds only
while the two names differ. A configuration that makes them the same is the one route by which
a founder action, which is by definition work no agent can do, reaches the column an agent
starts from. So it is closed by name, in both places a config is read:

- `validateWorkspaceConfigPatch` refuses the save, so the settings dialog says no while
  somebody is looking at the field they just typed into. Nothing is written.
- `loadWorkspace` refuses the config, so a file edited by hand loads as a project marked
  broken rather than as a board quietly resolving a name the operator can see is wrong.

Both compare the columns **as the board would resolve them** — trimmed, folded to lower case,
and defaulted on either side. A project that never wrote `projectTodoColumn` and calls its
founder column `Todo` collides with the default just as squarely as one that wrote both, and a
project that renamed its queue column onto `Founder Actions` collides from the other side. The
message names **both** keys, because either one of them is a legitimate thing to change and
nothing here knows which one was meant.

`scripts/check-founder-column-setting.mjs` covers the resolver, the setting's route through the
config loader and the validator, and the refusal over a table of configurations differing only
by case and by surrounding space.

## Where an action lives after the run that noticed it has ended

`src/core/founder-store.ts` keeps one JSON file per project under the board's own state
directory, written into a temporary file and then renamed over the old one — the way board
persistence writes a board, because a crash halfway through a plain write leaves half a document,
and half a document read at the next start loses every record rather than the one being written.

**A run is not written down and this is**, and the asymmetry is the argument for the file.
`src/core/implement-state.ts` holds its runs in a plain map, because what actually persists is
the worktree and the map is an inference read back off git at startup. A founder block is the
other shape entirely: the credit is still missing after a restart, the sign-in is still expired,
and nothing on disk anywhere says a person was asked. A record held only in memory would re-file
the same card on every boot and lose every Done somebody had already given it, which are the two
failures that make a column of human work unusable rather than merely thin.

**The key is the dedupe, and it is the point.** One signed-out `gh` is discovered by the project
poll, by the issue panel, by the queue's dependency reads and by every implement start.
`founderActionKey` composes the project, the kind and — for the kinds where one board can
honestly have two — a discriminator, so producers that noticed the same thing compose the same
string without having heard of one another, and every sighting after the first moves `lastSeenAt`
and nothing else. `dedupeBlockers` keeps the first sighting, with the evidence of whatever was
being attempted when it was seen. The suppression that existed before this was per surface and
transient, and none of it was a key a *different* producer could reuse.

`recordFounderAction` refuses anything `validateFounderAction` refuses and hands back the fault
list rather than storing bad text: that one door is where the register is enforced.
`appendChatTurn` is deliberately not validated — see [the chat](#the-chat-is-a-loop-of-headless-turns)
below.

A record is `open`, `resolved` or `dismissed`, and **none of the three is ever deleted**: a column
that forgets what it asked for asks for it again next week. `resolvedBy` says which of the two
things settled it, this board's own re-probe or the person the card was written for. What happens
to a settled record over months, and what a blocker that comes back does to one, are deliberately
not decided in that module.

### The store is the record, and GitHub is a projection of it

Everything else on this page follows from that one sentence. An action exists because the store
says so, not because a project item does — so a board with no `githubProject`, a project with no
founder column, and a `gh` that cannot be started all cost the action nothing at all. Publication
is the projection, and a projection that fails is a log line.

It has to be that way round. The first founder action this product will ever produce is
*"the GitHub CLI is not installed"*, and at that moment there is no project to file into and no
working `gh` to file with. [without-github.md](without-github.md) is the whole of that argument,
level by level.

## The four ways the queue is kept off a founder action

A founder action is by definition work no agent can do. The hazard is one press away — a coding
agent dispatched at *"put credit on the account"* burns a run and opens a pull request against a
decision no repository holds — so it is closed four independent times, and not one of the four is
a policy anybody has to remember.

1. **A published action is a draft item, and a draft is unstartable.** `buildProjectQuery` asks a
   `DraftIssue` for its title and creation date and nothing else, so `toBoard` builds the card
   with no url, no number and `draggable: false`. `startableCards` filters on five things — the
   content type is `Issue`, there is a url, the state is not closed, `draggable` is not false, and
   the number is not in the blocked set — and a draft fails three of them. It is unstartable
   **even after a person has dragged it into the column the queue drains**, which is the case that
   matters, because `moveCard` has no per-column policy at all.
2. **The canvas-owned column's option id cannot be written.** It is `canvas:founder`, and the `:`
   fails the `NODE_ID` pattern that every write to the project is validated against, so
   `buildMoveArgs` refuses it and `moveCard` — which builds its arguments there — refuses it as a
   target. That is the same guarantee `canvas:notes` has carried since the notes column was
   invented.
3. **A config that points the founder column at either of the other two is refused**, in both
   places a config is read. The queue drains exactly one column, resolved by name at dispatch
   time, so a founder column with a name of its own is invisible to the start loop *by
   construction* — and that construction holds only while the names differ. See
   [Naming the column per project](#naming-the-column-per-project) above.
4. **The panel resolves a founder card to a founder target, and never to an issue.**
   `resolvePanelTarget` evaluates the founder branch first, so `issueShapeOf` is not called at
   all on a card carrying a store key. That ordering is the fix rather than a filter, because
   `offersImplement` is handed only a GitHub state and an implement state and knows nothing about
   columns: it cannot be trusted to keep the Implement control off a founder card, so the target
   must simply not look like one. See [Choosing a founder card](#choosing-a-founder-card).

`scripts/check-founder-not-startable.mjs` holds the first two and the by-name drain, and it was
landed **before** anything could file a founder action — a fence installed after the producer it
protects has a window with nothing in it. It declares the reserved option id as a literal of its
own so that it does not depend on the column having landed, and every section carries a positive
control: a real open issue in the same fixture must come back startable, a deliberately mutated
draft must come back startable, and an ordinary option id must be accepted. An assertion that
cannot fail is not evidence. `scripts/check-founder-panel-target.mjs` holds the fourth.

## The column the canvas owns

The founder column is the second column this canvas draws for itself. `My Notes` was the first,
and the reason is the same one: a fresh clone has to be usable before anything is configured, and
a blocker about `gh` has nowhere on GitHub to be.

The reserved id and the guarantee it carries are guard 2 above. Everything else about how the
column is placed, ordered, counted and shifted is
[project-board.md](project-board.md#the-columns-a-board-is-expected-to-have)'s, because it is the
same mirror, drawn by the same layout, with the same header arithmetic — and restating it here is
how two documents come to disagree.

Two rules about it are this page's, because they are about founder actions rather than about
columns:

- **The `+` stays notes-only.** A founder action is never authored by hand; see
  [what this deliberately does not do](#what-this-deliberately-does-not-do).
- **A draft is an observation, wherever somebody put it.** Draft rehoming keeps rewriting every
  draft to the notes column, including one sitting in the founder column, and that is deliberate.

## Publishing to the GitHub project

`src/core/founder-publish.ts` puts an action on the project as a **draft item** — one
`gh project item-create` carrying the title and a body that is byte-for-byte
`renderFounderAction`'s own output — and never as an issue.

The reason is guard 1 above, and the alternative is a trap worth writing down because it is the
obvious first cut. `gh issue create` followed by a move cannot work: there is no
`gh project item-add` anywhere in this tree, so the issue is not on the project and the move
answers "is not on this project, so nothing was moved". Worse, if the project's *Item added to
project* workflow is on, GitHub adds the issue with the project's default status — commonly the
column the queue drains — and races the move. That decision is made outside this repository and
cannot be read back.

**Publication is on, and off is the switch.** `projectFounderPublishOff` in a project's
`board.config.json` is a *suppression*, and it is unset on a fresh board. The queue's own toggle
is the analogy that does not hold: that one starts coding agents against a repository and is
rightly off until somebody says so, where this one writes a card to a column whose entire point is
being seen. A feature whose whole point is visibility must not ship invisible.

The board is read **uncapped** to resolve the column, because `projectCardLimit` exists so that a
section does not draw hundreds of cards and a lookup must not inherit it.

Nothing about a failure to publish is a refusal, and the degradation follows the automatic card
moves' terms verbatim: no project spawns no `gh` at all and answers nothing; a project whose
options hold no founder column creates nothing and warns naming the setting that would fix it;
only `gh` itself failing throws, and a throw is non-fatal to the caller. A record that was not
published stays re-publishable and the next sighting tries again — a signed-out CLI is exactly
the blocker most likely to stop its own card going up — with one publication per key in flight at
a time, because the store's guard is read before anything is spawned and cannot see an attempt
that has not finished yet.

The item id is written onto the record **before** the placement rather than after: a failed
placement leaves one unplaced draft, where a failed record leaves an item created and
unremembered and the next pass files a second one.

`scripts/check-founder-publish.mjs` holds it, over a fixture whose columns are all renamed so that
nothing may key on a string.

## Choosing a founder card

A founder card is an ordinary `role: 'card'` under the mirror's own kind, carrying a store key in
`customData` — not a new kind and not a new role. That keeps every derived-element strip point
and the drag settler working on it unchanged, and it is why the panel needs guard 4: to the
resolver, before that guard, a founder card looked exactly like a card standing for an issue.

`resolvePanelTarget` answers a **founder target** for any shape carrying the mirror's kind and a
non-empty founder key, through the same walk-up a mirrored issue card gets — so a click landing on
the card's bound label resolves to the card rather than to nothing, which was a real defect once
and compiled perfectly. The target carries the key, the kind, the state and the title read off the
bound label, and `recreatable: false` as a stated field rather than only as an absence.

No Implement, Resume, Fix or Recreate control is reachable from it, because none of them is
offered a URL to act on.

## The panel, and the chat inside it

The card face carries a title and nothing else, so the what, the why, the steps and the confirm
sentence are read in the panel — the same anchored reading column a GitHub issue body uses.
`## Evidence` is the one part of a founder action written for an engineer, so it is present,
collapsed and closed until somebody asks for it: showing it by default undoes the feature.

### Done, and what taken on trust means

Marking an action done is not the last word, and that is deliberate. The honest way to close one
is to look again, and `src/core/founder-verify.ts` is the half that looks.
`verifyAgainst(kind, snapshot)` answers one of three things — `satisfied`, `still-blocked` or
`cannot-say` — with one line a person can read, and the third is the whole module.

**A probe that cannot say never closes an action and never blames anybody.** That rule is not
invented here: `readPushAccess` is already built on it, where only a permission GitHub explicitly
stated as non-pushing refuses a run and every failure to learn lets it through. Generalised, it is
what keeps the column from filling with cards about a bad network minute and a reader who stops
opening it.

Three of the ten kinds can only ever answer `cannot-say`, and they say so rather than guessing:
nothing this board runs can confirm that a rate limit has lifted, that a bill has been paid or
that a usage window has room. Only the next call that goes through shows any of them, and that
module makes no calls at all.

**Taken on trust** is the answer for exactly those: the person says they have done it, the record
settles with `resolvedBy: 'person'`, and the board says the word was taken rather than claiming
to have checked something it could not. `resolvedBy: 'probe'` is the other one — the board's own
re-probe no longer sees the blocker — and keeping the two distinguishable is why the field exists
at all. The reason line has a length limit of its own and may not begin like a command: this is
shown beside a card in a column written for somebody with a payment card and ten minutes, and
what the machine said belongs in the evidence.

The board also looks on its own, without being asked. A pass every
`EXCALIDRAW_FOUNDER_PASS_MS` — minutes rather than seconds, because it spends two probes per
project — reads what `gh` says about itself and settles every open record the verifier calls
`satisfied`. It is fast enough that somebody who has just signed in sees the card close while
they are still looking at the board. Set to `0` it is off, and what a *refused* run notices is
unaffected either way, because those producers run on the request that was refused rather than on
a timer. [running.md](running.md) has the setting.

### The chat is a loop of headless turns

The operator wants to ask *"which plan should I buy?"*, *"is the free tier enough?"*, *"I did it,
what now?"* — and to have the answer be able to change the card. The card is a record of named
fields and the register is its schema, so the agent cannot be the thing that writes it. It
answers the person and, at most, **offers** a revision in one fenced block; the board applies it,
and `parseFounderChatAnswer` is the gate in front of that.

The gate refuses a block naming another item, two blocks (nothing here can tell which one was
meant, and taking the first is a guess), a block touching the kind, the creation date, the
evidence or the published item, and a revision the register would refuse. **The founder still
gets the answer** in every one of those cases; what they lose is the edit, and they are told so.

**A turn is one headless run, and that is measured rather than preferred.** A readable transcript
needs a streaming output format, which the agent CLI accepts only beside the flag that reads the
prompt from stdin and spends it — and a pseudoterminal has no end of file to spend a second one
with, measured on this platform's console host. A readable run and a typeable session are
mutually exclusive under both named backends, so the conversation is kept by the board and every
turn is a new process. Nothing opens a terminal session for it either: one tab per founder action
would exhaust a board's session allowance, and a tab never ends by itself and reports no token
counts.

It is not a fourth agent role. It is the issue role — a run that reads and answers — with its
invocation narrowed in place.

`appendChatTurn` is not measured against the register, and that is deliberate: the founder types
what they like, and the reply is prose in a panel rather than card text. A stack trace and the
last stretch of somebody's stderr belong in a turn and are stored as they arrived. Sending the
chat through the validator is the obvious mistake — it would refuse the founder's own sentence
for being twenty-six words long.

### The chat may read and answer, and may not write

Handed the issue role's grant as it stands, a chat inherits `gh issue create`, `gh issue edit`,
`gh issue comment` and the whole of `gh project` — every one of them unscoped to any issue
number, because nothing in that allow-list grammar can express "only issue #N". An agent that
decides the right answer to *"which plan should I buy?"* is to open a tracking issue will open
one, and this board's own habit is to move a created issue into the column the queue drains. That
is a coding agent started by a question nobody reviewed.

`withoutGhWrites` closes it by taking those commands off the invocation. It **only ever removes**:
no rule that was not in the input appears in the output, which is what makes it safe to apply to
an argv nobody has read. The worst it can do is refuse a read.

**And here is the honest limit.** On two kinds of board there is nothing for it to narrow, and it
reports that rather than hiding it:

- a **`raw` backend**, which is the shipped default, spawns the operator's command line byte for
  byte and carries no grant this board wrote. The backend is asked first, before the argv is even
  looked at, precisely because a raw line that happened to contain this board's own list would be
  narrowed by argv while the string a run inside a distro is handed went on saying what it said;
- a board whose operator **pinned their own `--allowedTools`**. That list is a posture its author
  decided, and narrowing it would be this board overruling a grant rather than filling one in.

In both cases the chat is **refused**, in the wording the board already uses for an agent it
cannot run, with the cause said after it — because a chat that silently holds repository write
access is worse than no chat. The prompt does tell the agent it may not file anything, and prose
is not a boundary.

A run under a CLI that grants a read-only mode rather than a list needs nothing removed and is
allowed: `gh` cannot reach github.com from one.

`scripts/check-founder-chat-posture.mjs` asserts the **realised argv**, never the exported list —
a check reading the constant would pass on a build where the adapter had stopped writing it — and
its first case is the control that the grant really does reach those writes, so that it cannot go
green against a helper that does nothing.

## Resolving, and the queue that was quietly refusing

A blocker that clears has to change what the board does, not just what it draws. The one that
shows this best is `push-denied`: the account behind `gh` cannot push to the checkout's `origin`,
so `POST /api/implement` answers 403, and that is a decision about a login and a remote which no
interval alters — the same oldest card is refused for ever.

Before this milestone the start loop read only two statuses and fell through on everything else,
so a pass that had been refused every card reported *the column held nothing* and the board drew a
healthy idle queue over a card it was refusing every thirty seconds. That is now the queue's
`refused` reason: it stalls, it is announced, and its detail names the **founder action** rather
than repeating what `gh` said — which names a permission, a repository and a remote-URL command,
all true and none of it the thing to say to somebody looking at a queue that has stopped.
[issue-block.md](issue-block.md#the-queue-which-defers-instead-of-refusing) has the reason table,
and [project-board.md](project-board.md#the-queue-toggle) has what the toggle does about it.

The refusals that file a record are the ones a person can act on. The 403 for a push permission
and the 404 for an agent that is not there each record before they answer; the 400 for a board
that is misconfigured does not, because that is a board problem and admitting those is how a
column written for a person fills with advice. Every status, body and refusal sentence is
byte-identical to what it was before founder actions existed, which is why the record travels
beside the answer rather than inside its body.

## What this deliberately does not do

Three things were left out on purpose, and each has a reason rather than a backlog entry.

- **Authoring one by hand.** The `+` on the mirror stays notes-only. A founder action is a
  *finding* — something a probe or a refusal noticed — and the register is enforced at the write
  precisely so that no prose route into the column exists. A hand-authored one would be the free
  text this whole design removes, and it would have no evidence, no kind and no verifier.
- **Image attachments in the chat.** An issue block takes reference images and this does not.
  Nothing about the founder store, the prompt or the answer gate handles bytes, and a screenshot
  of a billing page is the single most likely thing to carry an account number into a file this
  board writes. [whats-next.md](whats-next.md) carries it as the open question it is.
- **A hotkey of its own.** `Alt+B` already scrolls onto the mirror and the founder column is part
  of the mirror, so a second accelerator would spend one of the few chords Excalidraw leaves free
  on a shorter walk to the same place. [project-board.md](project-board.md#the-hotkey) is where
  the one hotkey is described.
