# The board without GitHub

This tool is built around an issue that becomes a pull request, so it is easy to read it as a
GitHub client with a canvas attached. It is not. Every GitHub feature is behind a setting that a
fresh clone does not have, each one degrades on its own, and what is left over is most of the
tool: a canvas that syncs, documentation cards, terminals, projects, exports.

None of that was written down, and until #321 none of it was checked either. This page is the
contract, and `scripts/check-github-absent.mjs` is what holds the largest part of it.

## Four levels, and they are independent

They are not a ladder. A machine can have `gh` installed and logged in and still be at level 2,
and a checkout can be a perfectly good git repository whose `origin` is on a GitLab somewhere.
Each row is one thing being absent.

| Level | What is absent | What stops | What keeps working |
|---|---|---|---|
| 1 | `gh` is not installed, or not logged in | Every GitHub read and write: the mirror, the issue block's "Create issue", implementing | The canvas, documents, terminals, projects, sync, export — and founder actions, which are what a board at this level is *for* |
| 2 | `gh` works, but no `githubProject` | The mirrored columns and the card moves that follow a run | Everything at level 1, plus the notes column, its `+`, issue blocks, implement runs and the founder column |
| 3 | `origin` is not on `github.com`, and no `repo` | Creating issues from a block, and interrupted-run recovery | Everything else, including the mirror if a `githubProject` is configured |
| 4 | The project is not a git repository | Worktree isolation, and interrupted-run recovery | Everything else; the run happens in the project directory itself |

## Level 1 — no `gh`

Nothing on the board waits for `gh`, and nothing on the board pretends it is there.

`GET /api/github-status` runs `gh --version` and `gh auth status` and turns the outcome into an
answer rather than an exception (`src/core/github-status.ts`). Not installed, not logged in, and
logged in without the `project` scope are three different things, and it says which. `/health`
carries the short form of the same verdict — `resolved` and a version number, and never the
login or the token's scopes, because that route is not loopback-only.

When a board that *does* name a `githubProject` cannot read it, `GET /api/project-board` answers
502 with whatever `gh` said, the canvas draws a strip saying so where the mirror would have been,
and announces it once per board rather than once per twenty-second poll.

A CLI that is not there is asked **once**, not three times: `classifyGhFailure`
(`src/core/gh.ts`) reads `command not found` and the spawn errnos as terminal and puts the
command that fixes it on the end of `gh`'s own sentence, so what reaches the canvas is a remedy
rather than the same refusal 1.6 seconds later.

What is unaffected is everything that is not GitHub: the element store, the sync, the export, the
documentation cards, the terminal blocks, the project tabs, the settings dialog. None of those
routes reaches `gh` at all.

## Level 2 — `gh`, but no project

`githubProject` is the one field registration will never invent. A repository can be derived from
an `origin` remote; a project board belongs to an account, nothing on disk implies one, and a
guess there would point `gh` at somebody else's board. So every newly registered project is at
this level until somebody writes the URL in.

`GET /api/project-board` answers **404** with `reason: "no-project"` and a sentence naming the
setting. That is a refusal decided from the workspace, before anything is spawned — no `gh`
process is started to discover that there is no project. `moveIssueToColumn` returns `null` the
same way (`src/core/project-board.ts`), so a run that would have moved its card to *In Progress*
simply does not, and nothing about the run fails.

**The `+` is still there.** This used to be the expensive part of level 2: the notes column is
drawn by the mirror, the canvas read a 404 as "clear the region", and a board with no project
therefore had no notes column, no `+`, and no route to the issue block at all — the headline
feature reachable only after a step nothing on the canvas asked for. Since #316 a 404 draws
`notesOnlyBoard()`: a board of no sections, which the same layout draws the notes column in front
of exactly as it does for a project of four. Writing an observation down and turning it into an
issue both work here.

## Level 3 — a remote that is not on `github.com`

`github.com` is a requirement this board states once, in `src/core/github-host.ts`, rather than a
host resolved per workspace. `repoFromRemoteUrl` is anchored at the host, so a remote on
`mygithub.com` or on a GitLab parses as no repository rather than as somebody else's.

Two things read that answer, and both prefer `repo` in the board's own configuration before they
fall back to `origin`:

- **Creating an issue from a block** is refused before the agent is spawned, with a sentence that
  names the remote it found rather than claiming there is none. A coding agent sent off to
  discover this takes minutes to fail, and the observation on the block is kept either way.
- **Interrupted-run recovery** logs the same distinction and offers nothing
  (`src/core/implement-recovery.ts`). The worktrees are still there and still hold their work;
  what is missing is the issue URL to name them by.

The mirror is unaffected: it reads a project URL, not a remote.

## Level 4 — not a git repository

A board can be pointed at any directory. `ensureWorktree` asks git whether the directory is
inside a work tree, and when it is not it warns that the run is not isolated and returns `null`
(`src/core/implement-worktree.ts`) — the implementation then happens in the project directory
itself, on whatever branch is there. `worktreesHoldingWork` answers the same question the same
way and returns an empty list, so there is nothing to recover.

The distinction that matters here is between *git said no* and *git could not be started*. The
second is a refusal, not a `null`: running an implement agent unisolated in a real checkout
because the `PATH` was missing a Homebrew prefix is worse than not running it.

## Founder actions are the one feature built the other way round

Everything above degrades: a level takes something away and the rest carries on. Founder actions
are the exception, because they are the feature that has the *most* to do at level 1 and the least
to do at level 4. The first founder action this product will ever produce is *"the GitHub CLI is
not installed"* — and at that moment there is no project to file it into and no working `gh` to
file it with. A design that needed either would be a design that goes quiet exactly when it is
needed.

So the whole of it works with no `gh` and no project at all:

- **produced.** The periodic pass reads what `gh` says about itself through the same probe
  `GET /api/github-status` uses rather than through the retrying command runner, which makes it
  the only detector that sees a missing or signed-out CLI on a board with no project and no
  repository. Every other producer needs somebody to have asked for something first.
- **stored.** [founder-actions.md](founder-actions.md#where-an-action-lives-after-the-run-that-noticed-it-has-ended)
  is a JSON file per project beside the board's own state. Nothing about it reaches GitHub, and a
  restart neither re-files a card nor forgets a Done.
- **drawn.** The founder column is one of the two the canvas owns, and it appears on a board of no
  sections exactly as the notes column does — the same argument #316 settled for the `+`, applied
  to the column a blocker about `gh` has to land in.
- **chatted about.** A chat turn runs a coding agent, which is a different program from `gh`.
  Whether it can run at all is a question about the agent and its permissions
  ([founder-actions.md](founder-actions.md#the-chat-may-read-and-answer-and-may-not-write)), and
  the GitHub writes are taken off it in any case.

Publication is the only half that needs GitHub, and it is the projection rather than the record: a
board with no `githubProject` spawns no `gh` at all and publishes nothing, a project with no
founder column creates nothing and warns naming the setting that would fix it, and a `gh` that
fails leaves the record re-publishable. None of the three costs the action anything, because the
store is what says it exists.

`scripts/check-founder-producers.mjs` drives the producers and the pass against a stubbed `gh`,
and `scripts/check-founder-publish.mjs` holds the three degradations, one of its boards naming no
project at all.

## What never asks GitHub anything

Worth stating positively, because it is the larger half of the tool:

- the element store and everything on `/api/elements`, including sync and reconciliation;
- `GET /api/docs/:key`, for the project's own documents and for the ones the tool ships with its
  blocks;
- the terminal routes and the sessions behind them;
- the project registry, the tabs, the settings dialog and board persistence;
- every export and import path.

## Where each level is held

| Level | The check |
|---|---|
| 1 and 2 | [../scripts/check-github-absent.mjs](../scripts/check-github-absent.mjs) — a server with a `gh` that exits 127 and no `githubProject`, asserting the canvas, the documents, the terminal and a readable refusal from the mirror |
| 3 | [../scripts/check-github-host.mjs](../scripts/check-github-host.mjs) — the five places the host was compiled into, held to one answer |
| 4 | [../scripts/check-worktree-git-missing.mjs](../scripts/check-worktree-git-missing.mjs) — a directory that is no repository, and the separate case of a git that will not start |

[running.md](running.md) is what to set when you do want GitHub, and
[workspaces.md](workspaces.md) is where `githubProject` and `repo` live.
