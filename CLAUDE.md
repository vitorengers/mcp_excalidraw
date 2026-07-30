# How work is done in this repository

This file exists because the workflow below was, until now, only in one machine's local agent
memory. The implement agent's prompt deliberately states no workflow — it tells the agent to read
the project's own memory and treat that as the authority, so the feature stays right for every
other board — which means an untracked file on one machine was the only thing standing between
this project and the prompt's generic fallback. A fresh clone had no way to find out.

## Everything written into the repository is English

Code, comments, documentation, board content, branch names, commit messages, issues, pull
requests. Conversation with the maintainer is Portuguese; the repository is not correspondence.
`scripts/check-english-only.mjs` enforces it on tracked artifacts.

## Issue first, then a branch, then a pull request you merge yourself

1. **Open an issue** and add it to
   [Project 5](https://github.com/users/vitorengers/projects/5). The board is the record — work
   that lands without an issue disappears from it.
2. **Branch from `main`**, one branch per issue. Never commit to `main` directly, and that
   includes board data: a re-exported `docs/board.excalidraw` is a commit like any other.
3. **Open a pull request** whose body says `Closes #N`.
4. **Merge it yourself** — squash, delete the branch. Pull requests are not left open for review.

An implementation started from the board gets a git worktree of its own, created by the server
before the agent is spawned: `<project>-worktrees/issue-<n>`, on a branch of the same name, cut
from the default branch. It is a real checkout of this repository, so the steps above are
unchanged — commit there, push from there, open the pull request from there. See
[docs/issue-block.md](docs/issue-block.md).

## Every behaviour change ships with a check

A `scripts/check-*.mjs`, and it is run **against the old code first**, to prove it catches the
defect before the fix goes in. The ordering is the point: a check written after the fix tends to
describe the fix rather than the defect, and passes for the wrong reason.

Checks are plain Node scripts with no test framework, and **every one of them runs with no
arguments**: it builds its own throwaway workspace and stubs, starts its own canvas server on a
port the kernel just handed out, and kills it. `scripts/check-implement-parallel.mjs` is the
fullest example, and `scripts/check-no-external-server.mjs` is what holds the rule. A check that
needed a server somebody else had started, with the right stubs, in a convention written down
only in prose, was a check nobody could run.

`--url http://127.0.0.1:3737` survives on the older ones as an explicit override, for pointing a
check at the board you are looking at while debugging. It is never the default, and the
environment gets no vote at all — a run with no `--url` starts its own server whatever is set.
Those cases write to the board they are pointed at, so it is a debugging move rather than a way
to run the suite.

**3737 is the board**, the port the operator starts it on, because 3000 cannot work on this
machine ([docs/trap-port-3000.md](docs/trap-port-3000.md)).
[docs/running.md](docs/running.md) is the run procedure, and
[docs/index.md](docs/index.md) indexes everything else.

## Every change updates both halves of the board

The Board Tool board (`docs/board.excalidraw`) is cut into two marked sections, each with a key
that scrolls onto it — see [docs/board-sections.md](docs/board-sections.md).

- **Project structure** (`Alt+P`) — what the tool is: the architecture, the blocks on the canvas,
  how to try it. Undated, always describing the present.
- **Development** (`Alt+G`) — how it got that way: the traps already paid for, what is next, and
  [docs/development-log.md](docs/development-log.md), one dated entry per merged pull request.

An implementation is **not finished** until both are true of what it just landed:

1. **The log has its entry**, at the top of the table, written before the merge: the ISO date, the
   issue, the pull request, and what was decided — the decision, not the diff. `git log` already
   has the diff. Because the entry is written first, the log runs one merge ahead of `git log`;
   the check only fails the other way, on a merge with no entry.
2. **The structure map reflects any architecture or feature change.** The boundary is a file, a
   route, a block kind or a feature added or removed. A race fixed and a label repositioned change
   no architecture and belong in the log only — a rule that fires on every change gets ignored.
3. **A new tracked `docs/*.md` gets a card**, in whichever section it belongs to. A document no
   block points at is a document nobody opens.

`node scripts/check-board-map.mjs` enforces all three, plus the section marks themselves. This is
board data, so it lands the same way everything else does: on the branch, in the pull request,
never straight onto `main`.

## Verifying

```
./node_modules/.bin/tsc          # the server
./node_modules/.bin/vite build   # the frontend
node scripts/check-<name>.mjs
node scripts/check-board-map.mjs # the board and the log still describe what landed
```

**Compiling is not working, and this project has paid for that repeatedly.** Three real defects in
the UI layer — a panel that never opened, a race in tab initialisation, a click landing on the
label instead of the box — compiled perfectly and did none of what they claimed. Anything that
changes what the browser does has to be looked at in a browser.
