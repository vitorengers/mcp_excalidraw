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

## What is not written here yet

The register is the first half of the column and the rest of it lands separately. Each heading
here is a stub of one sentence, and the change that fills it in is the one that ships the
behaviour — so nothing in this section is a promise about a file that exists today.

### A founder action outliving the process that noticed it

Where a founder action is kept once the run that noticed it has ended, and what a second sighting
of the same blocker does to the one already there.

### The column the canvas owns

How the column is drawn on a board that has never had one, so the first blocker on a fresh clone
has somewhere to land.

### Publishing to the GitHub project

How a founder action reaches the project board as a draft item rather than as an issue, and why
an issue would be the wrong shape.

### Choosing a founder card

What happens when a founder card is selected, and why the selection may never resolve to an
issue anything is going to implement.

### The panel, and the chat inside it

What the panel shows, what taking a founder action as done means, and what the chat beside it may
and may not do on the reader's behalf.

### Resolving, and asking again

What a resolve does, why it re-probes rather than taking the word for it, and what a queue pass
that refused every card has to report instead of a healthy idle board.
