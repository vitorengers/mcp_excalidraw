# Sync reconciliation

`POST /api/elements/sync` is how the browser hands its scene back to the server. It used to
`clear()` the store and rewrite it from the payload, which made **absence mean deletion**.
An element created through the API seconds earlier — one the browser had never seen — vanished
on the next autosync. The API and the canvas were fighting over the same store, and the canvas
always won.

## The rule now

Merge by `id`:

- the incoming element wins when its `version` is higher than the stored one;
- `versionNonce` breaks the tie when versions are equal, so two clients converge on the same
  winner rather than on whoever spoke last;
- an element the payload never mentions is **left alone**;
- deletion is explicit — it travels as a tombstone, an element carrying `isDeleted: true`.

`version` is preserved rather than reset, because it is what makes the *next* reconciliation
possible. Overwriting it with `1` would make every stored element look older than everything
that arrives afterwards.

## What the version race does not decide

Winning the race wins the *shape*, not the whole element. `version` is a number the browser
owns: Excalidraw bumps it on every keystroke, drag and nudge, while the server bumps it once
per state change — so the browser is routinely several versions ahead, and a payload built
before a server write but applied after it reverts that write in full.

Measured on a real board, with a research run in flight: the browser held the block at
`version` 8 while the store held it at 3, and stayed there for two seconds
(`scripts/check-issue-state-sync-browser.mjs` is that measurement, printed on every run).
Anything the run wrote in that window would have gone back to whatever the browser last knew
— which for a block whose run started while the reader was still working on it is the
pristine draft, with no `issueState` on it at all.

That is #118: three blocks that produced #94, #95 and #96 and kept no record of it. So the
fields the server authors are taken out of the race altogether. `src/core/element-authorship.ts`
names them — `issueState`, `issueUrl`, `issueError`, `issueTitle`, `observation`, and the five
`implement*` fields — and the merge restores them from the store onto any payload that
disagrees, along with the appearance the state is drawn from. **Both directions**: a field the
store does not hold is *removed* from the payload, or a browser still holding `running` after
`DELETE /api/issue-block/:id` would put it straight back.

A version number can decide where a shape sits and what its label says, because those are the
browser's to decide. It cannot decide whether an issue exists, because the browser was never
told and has no way of finding out. Everything else about the element still comes from the
payload, including its `version` — a merge that answered this by ignoring the browser would
break what the sync is for, and `check-issue-state-sync.mjs` asserts that half as well.

## Where it lives

- Endpoint: `src/server.ts`, the `/api/elements/sync` handler
- Store: `src/core/element-store.ts` — one `Map` per workspace
- What the browser may not overwrite: `src/core/element-authorship.ts`
- Checks: `scripts/check-sync-reconcile.mjs`, `scripts/check-issue-state-sync.mjs`,
  `scripts/check-issue-state-sync-browser.mjs`

## Why the check matters

Run `node scripts/check-sync-reconcile.mjs`. It starts an empty instance of its own, which is
what the cases need — an element that survives a sync is only visible on a board nothing else
has written to. Four cases: the API element survives a sync that omits it, a tombstone removes while
an absence does not, the newest version wins a race, and `version` is not overwritten. Against
the old clear-and-replace code the first case fails immediately.
