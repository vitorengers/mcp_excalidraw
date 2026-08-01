# AGENTS.md — how work is done in this repository

You are an agent changing this repository. This file is the working agreement, under the
filename most coding agents read; [CONTRIBUTING.md](CONTRIBUTING.md) is the same agreement
written for a person, at more length and with the reasoning; [CLAUDE.md](CLAUDE.md) is a pointer
at this one. Where they say the same thing they are meant to, and where you find them
disagreeing that is a defect worth an issue.

Not to be confused with [docs/agents.md](docs/agents.md), which is a different subject under a
similar name: that one is for an *operator* configuring which agent binary this board spawns,
and this one is the agreement whatever binary you turn out to be.

Nothing here depends on which vendor you are. What does depend on the machine — which project
board this repository's own board is pointed at, which port it is started on, how a merge is
done in the maintainer's own checkout — is in [MAINTAINERS.md](MAINTAINERS.md). **If you were
spawned by this project's own board**, into a worktree it created for an issue, that file is
your authority and it is not the same workflow as the one below.

## The loop

1. Open an issue, or work from one you were given.
2. Branch from the default branch, one branch per issue. Never commit to the default branch
   directly, and that includes board data: a re-exported `docs/board.excalidraw` is a commit
   like any other.
3. Write the check first and run it against the old code.
4. Make the change. Update the board and the log with it.
5. Build, run the checks, read the output.
6. Open a pull request whose body says `Closes #N`. A maintainer reviews it and merges it.

## Everything written into the repository is English

Code, comments, documentation, board content, branch names, commit messages, issues, pull
requests. `scripts/check-english-only.mjs` enforces it on tracked artifacts, so a lapse is a red
run rather than a note in review. Take the language from this rule and not from the repository
you were reading a moment ago.

## Every behaviour change ships with a check

A `scripts/check-*.mjs`, and it is run **against the old code first**, to prove it catches the
defect before the fix goes in. The ordering is the point: a check written after the fix tends to
describe the fix rather than the defect, and passes for the wrong reason. Say in the pull request
which cases were red and against what.

Proving one red usually means putting the old code back for a moment — a throwaway commit you
revert, or `git checkout <sha> -- <paths>` into a scratch build. A `*-browser.mjs` check loads
`dist/frontend`, so the old code has to be *built*, not merely restored: an unbuilt revert leaves
the new frontend on disk and the check passes against code that is not there.

Checks are plain Node scripts with no test framework, and **every one of them runs with no
arguments**: it builds its own throwaway workspace and its own stubs, starts its own canvas
server on a port the kernel just handed it, and kills it. Do not write one that expects a server
somebody else started, and do not read its target out of the environment.
`scripts/check-implement-parallel.mjs` is the fullest example and
`scripts/check-no-external-server.mjs` is what holds the rule. Declare a `Tier:` in the banner —
`fast`, `browser`, `windows`, `wsl` or `repo` — and pick the narrowest one that is true.

Half of this rule is a gate. `scripts/check-change-has-check.mjs` runs on every pull request and
is red if the range changes anything under `src/` or `frontend/src/` and adds or modifies no
`scripts/check-*.mjs`. Run it before you open one:

```
node scripts/check-change-has-check.mjs --base origin/main
```

The other half is not a gate and cannot be. Nothing in a squashed pull request records which
file was written first, so the **ordering** is verified by a person reading the failing output
you pasted — which is why the pull request template asks for the check's name, the command, and
what it printed when it was red. Paste the real output; do not describe it.

Where the change genuinely has no check to bring — a rename, a formatting sweep, a dependency
bump — put a line in the pull request body and the gate stands down:

```
No-behaviour-change: renamed the module, no call site changed
```

A trailer rather than a label, because the squash merge carries the body into the commit and
drops the labels. The reason is the whole of it: an empty trailer or an unreplaced placeholder
is refused. Reaching for it on a change that does alter behaviour is the rule working, not an
obstacle to route around.

## Every change updates the board and the log

`docs/board.excalidraw` is this repository's own board, cut into two marked sections
([docs/board-sections.md](docs/board-sections.md)): **Project structure**, undated, describing
what the tool is right now; and **Development**, how it got that way, which is where
`docs/development-log.md` lives.

A change is not finished until:

1. **the log has its entry**, at the top of the table, written before the merge — the ISO date,
   the issue, the pull request, and what was **decided**. Not the diff; `git log` has the diff.
2. **the structure map reflects any architecture or feature change.** The boundary is a file, a
   route, a block kind or a feature added or removed. A race fixed or a label repositioned
   changes no architecture and belongs in the log only.
3. **a new tracked `docs/*.md` has a card** in whichever section it belongs to.

`node scripts/check-board-map.mjs` enforces all three plus the section marks. Board data lands
on the branch and in the pull request like everything else.

## Compiling is not working

Anything that changes what the browser does has to be looked at in a browser. Three real defects
in this UI layer — a panel that never opened, a race in tab initialisation, a click landing on
the label instead of the box — compiled perfectly and did none of what they claimed. A green
type check is not evidence about the DOM. Drive it, screenshot it, and read the screenshot.

## Verifying

```
./node_modules/.bin/tsc          # the server
./node_modules/.bin/vite build   # the frontend
node scripts/check-<name>.mjs    # the check you wrote
node scripts/check-board-map.mjs # the board and the log still describe what landed
npm test                         # and then all of them — scripts/run-checks.mjs
```

`npm test` is the whole suite and is non-zero if any check fails. It does not build: a missing
`dist/` stops it rather than being made, because a check that only passes because the runner
rebuilt the frontend for it is a check nobody can reproduce by hand. `--only` and `--skip` take
globs over the file name, `--tier` selects by what a check needs, and a check that hangs is
killed at 180 seconds and reported as `TIMEOUT`. [docs/running.md](docs/running.md) is the run
procedure and [docs/index.md](docs/index.md) indexes everything else.

## Reporting

Say what you did, what you verified, and what you did not. A partial change described accurately
is worth more than a complete one claimed falsely. If part of the work was blocked, finish the
rest and name the part you left out and why.
