<!--
The two boxes below are not ceremony: they are the rules CONTRIBUTING.md binds every change to,
and each of them exists because something shipped without it once. Tick what is true and say so
where it is not — a pull request that explains why a rule does not apply is fine, one that
leaves the box blank is a question somebody has to ask.
-->

Closes #

## What this changes

<!-- The decision, not the diff. `git log` already has the diff. -->

## The check

<!--
Every behaviour change ships with a `scripts/check-*.mjs`, and it is run against the OLD code
first, to prove it catches the defect before the fix goes in. A check written after the fix
tends to describe the fix rather than the defect, and passes for the wrong reason.

Name it here, and say what it printed when it was red.
-->

- [ ] a `scripts/check-*.mjs` — name it here — run against the old code first, and it failed there
- [ ] …or this changes no behaviour (documentation, a rename, board data), and here is why:

## The board

<!--
The board is cut into two halves and both have to keep describing what is there:
`docs/development-log.md` gets its entry before the merge, and the structure map gets a card
when a file, a route, a block kind or a feature appears or disappears. A new tracked
`docs/*.md` gets a card too. `node scripts/check-board-map.mjs` enforces all three, and
CONTRIBUTING.md is where all of it is argued out.
-->

- [ ] `docs/development-log.md` has this change's entry, at the top of the table
- [ ] the structure map reflects it, or this changes no architecture

## Verified by

<!-- Compiling is not working. Anything that changes what the browser does was looked at in one. -->

```
./node_modules/.bin/tsc
./node_modules/.bin/vite build
node scripts/check-______.mjs
node scripts/check-board-map.mjs
npm test
```
