# Contributing to VibeMaxxing

This is the working agreement: the conventions that bind anyone who changes this repository,
whoever they are and whatever they are using to do it. There is one copy of it and this is the
copy — [AGENTS.md](AGENTS.md) is the same agreement written for a coding agent to load, and
[CLAUDE.md](CLAUDE.md) is a pointer at that.

Nothing here is about the maintainer's own machine. What is — which project board this
repository's own board is pointed at, which port it is started on, how a merge is done in the
maintainer's checkout — is in [MAINTAINERS.md](MAINTAINERS.md), and it is nobody else's to
follow.

Before changing any of the pieces, [docs/architecture.md](docs/architecture.md) is one page on
how they fit: every directory, and one press on an issue block followed to the coding agent it
spawns. [docs/index.md](docs/index.md) indexes everything else.

## The short version

1. Open an issue, or find one, so there is something to point the change at.
2. Branch, one branch per issue. Never commit to the default branch.
3. Write the check **before** the fix, and run it against the old code.
4. Make the change. Update `docs/board.excalidraw` and `docs/development-log.md` with it.
5. Run `npm test` and read the output.
6. Open a pull request whose body says `Closes #N`. A maintainer reviews it and merges it.

The rules below are the ones a review will hold you to.

## Everything written into the repository is English

Code, comments, documentation, board content, branch names, commit messages, issues, pull
requests. `scripts/check-english-only.mjs` enforces it on tracked artifacts, so this is a rule
the suite fails on rather than a preference somebody restates in review.

It is a rule about the repository and not about you. What language you think in, or write your
issue description in before you translate it, is your business.

## Every behaviour change ships with a check

A `scripts/check-*.mjs`, and it is run **against the old code first**, to prove it catches the
defect before the fix goes in. The ordering is the point: a check written after the fix tends to
describe the fix rather than the defect, and passes for the wrong reason.

A worked example, from a change that landed. `scripts/check-agent-stream-unknown-event.mjs`
exists because an agent-stream event of an unrecognised type rendered to an empty string, and an
empty render is dropped — so a stream made entirely of such events produced a block that stayed
blank for its whole run, which from outside is indistinguishable from an agent that has stopped.
The check drives a real terminal session with a stub that writes four events of a type nothing
claims, and asserts the scrollback is not empty. It was written first and **red on five cases**,
one of them the blank block itself. Only then was the renderer's fallback widened. Had it been
written afterwards it would have asserted whatever the new fallback happened to print, and would
have passed on the day the defect returned in a different shape.

Checks are plain Node scripts with no test framework, and **every one of them runs with no
arguments**: it builds its own throwaway workspace and its own stubs, starts its own canvas
server on a port the kernel just handed it, and kills it. `scripts/check-implement-parallel.mjs`
is the fullest example, and `scripts/check-no-external-server.mjs` is what holds the rule. There
is nothing for you to start first, nothing to keep free, and no port to pick: a check that needed
a server somebody else had started, with the right stubs, in a convention written down only in
prose, was a check nobody could run.

Each check declares a `Tier:` in its banner saying what it needs beyond Node and a built
`dist/` — `fast`, `browser`, `windows`, `wsl` or `repo`. Put yours in the narrowest one that is
true.

## Every change updates the board and the log

This repository's own board is `docs/board.excalidraw`, cut into two marked sections
([docs/board-sections.md](docs/board-sections.md)):

- **Project structure** — what the tool is: the architecture, the blocks on the canvas, how to
  try it. Undated, always describing the present.
- **Development** — how it got that way: the traps already paid for, what is next, and
  `docs/development-log.md`, one dated entry per merged pull request.

A change is not finished until both are true of what it just landed:

1. **The log has its entry**, at the top of the table, written before the merge: the ISO date,
   the issue, the pull request, and what was decided — the decision, not the diff. `git log`
   already has the diff.
2. **The structure map reflects any architecture or feature change.** The boundary is a file, a
   route, a block kind or a feature added or removed. A race fixed and a label repositioned
   change no architecture and belong in the log only — a rule that fires on every change gets
   ignored.
3. **A new tracked `docs/*.md` gets a card**, in whichever section it belongs to. A document no
   block points at is a document nobody opens.

`node scripts/check-board-map.mjs` enforces all three, plus the section marks themselves. The
board is data in the repository, so it lands the same way everything else does: on the branch,
in the pull request.

If you have no board running, `docs/board.excalidraw` is still an ordinary file and the log is
still Markdown. Say so in the pull request and a maintainer will re-export the board.

## Compiling is not working

Anything that changes what the browser does has to be looked at in a browser. This project has
paid for the rule three times: a panel that never opened, a race in tab initialisation, a click
landing on the label instead of the box — all three compiled perfectly and did none of what they
claimed. A `*-browser.mjs` check drives a real headless Chrome for exactly this reason, and a
screenshot you actually read is worth more than a type that checks out.

## Verifying

```
./node_modules/.bin/tsc          # the server
./node_modules/.bin/vite build   # the frontend
node scripts/check-<name>.mjs    # the check you just wrote
node scripts/check-board-map.mjs # the board and the log still describe what landed
npm test                         # and then all of them — scripts/run-checks.mjs
```

`npm test` is the whole suite and is non-zero if any check fails. It does **not** build: a
missing `dist/` stops it rather than being made, because a check that only passes because the
runner rebuilt the frontend for it is a check nobody can reproduce by hand.

`node scripts/run-checks.mjs --help` has every flag. `--only` and `--skip` take globs over the
file name, `--tier` selects by what a check needs, and a check that hangs is killed at 180
seconds with everything it started and reported as `TIMEOUT`. The contributor gate is
`--tier fast,browser`; `repo` and `wsl` cannot be satisfied from a fork and are not expected of
you. [docs/running.md](docs/running.md) is the fuller procedure and
[docs/index.md](docs/index.md) indexes everything else.

## Opening a pull request

One branch per issue, a body that says `Closes #N`, and a description of what was **decided** —
the same thing the log entry says. Pull requests are reviewed and merged by a maintainer.

Bug reports and pull requests belong on
[this repository's issue tracker](https://github.com/vitorengers/vibemaxxing/issues), which has
a form for each; `.github/pull_request_template.md` is the rules above as a checklist.

Two documents sit beside this one. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) is what is expected
of everyone taking part. [docs/SECURITY.md](docs/SECURITY.md) is the trust model of a tool that
spawns coding agents and real shells — read it before you enable either, and report a
vulnerability there rather than on the issue tracker, where it would be public from the moment
you filed it.
