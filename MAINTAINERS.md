# MAINTAINERS.md — the half that belongs to this board

Everything in [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) binds anybody who
changes this repository. What follows binds nobody but the maintainer of this board and the
agents it spawns into its own worktrees, and it is here rather than in those two files because a
contributor reading it would be told to write to a project board they have no access to, to merge
their own pull request, and to hold a port that is only a fact about one machine.

If you arrived through a clone or a fork: this file is not for you, and skipping it costs you
nothing.

## Conversation is Portuguese, the repository is English

Conversation with the maintainer is in Portuguese; the repository is not correspondence. The
English rule in `CONTRIBUTING.md` is about tracked artifacts and is unaffected either way.

## Issue first, then a branch, then a pull request you merge yourself

1. **Open an issue** and add it to the GitHub project this board is configured for — the
   `githubProject` of the workspace you are working in, which lives in an untracked
   `board.config.local.json` rather than in the repository, because a project board belongs to an
   account and not to a clone ([docs/workspaces.md](docs/workspaces.md)). The board is the
   record — work that lands without an issue disappears from it.
2. **Branch from the default branch**, one branch per issue. Never commit to it directly, and
   that includes board data.
3. **Open a pull request** whose body says `Closes #N`.
4. **Merge it yourself** — squash, delete the branch. Pull requests here are not left open for
   review, because the reviewer and the author are the same person and an open pull request is
   then just a queue nobody drains.

That last step is the one a contributor must not copy, and the reason these two workflows are
written down separately rather than as one with an exception in it.

An implementation started from the board gets a git worktree of its own, created by the server
before the agent is spawned: `<project>-worktrees/issue-<n>`, on a branch of the same name, cut
from the default branch. It is a real checkout of this repository, so the steps above are
unchanged — commit there, push from there, open the pull request from there. See
[docs/issue-block.md](docs/issue-block.md).

Several implementations run at once, so the default branch usually moved while you were working:
bring the branch up to date with it, rebuild, and re-run the checks before merging.

## The port this board is started on

**3737 is the board** — the port the operator starts it on, chosen because 3000 cannot be bound
on this machine ([docs/trap-port-3000.md](docs/trap-port-3000.md)). It is the shipped default of
the canvas server as well, so nothing has to be set to get it.

None of that reaches the checks. Every check starts its own canvas server on a port the kernel
hands it, whatever is running and whatever is set in the environment. What survives on the older
ones is an explicit `--url http://127.0.0.1:3737` override, for pointing a check at the board you
are looking at while debugging; those runs write to the board they are pointed at, so it is a
debugging move rather than a way to run the suite.

[docs/running.md](docs/running.md) is the run procedure.
