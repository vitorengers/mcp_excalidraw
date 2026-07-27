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

Checks are plain Node scripts with no test framework. The self-contained ones build a throwaway
workspace, start their own canvas server on a free port and kill it —
`scripts/check-implement-parallel.mjs` is the fullest example. The older ones take
`--url http://127.0.0.1:3838` and run against a server started separately, which must be a
separate, empty instance rather than the board you are using.

## Verifying

```
./node_modules/.bin/tsc          # the server
./node_modules/.bin/vite build   # the frontend
node scripts/check-<name>.mjs
```

**Compiling is not working, and this project has paid for that repeatedly.** Three real defects in
the UI layer — a panel that never opened, a race in tab initialisation, a click landing on the
label instead of the box — compiled perfectly and did none of what they claimed. Anything that
changes what the browser does has to be looked at in a browser.
