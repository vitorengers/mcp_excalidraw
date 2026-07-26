# Trap: board exports are noisy to diff

Export a board twice without touching it and the two files differ everywhere. The server stamps
its own bookkeeping onto every element as it passes through:

```
syncedAt · source · syncTimestamp · createdAt · updatedAt
```

`syncedAt` and `syncTimestamp` change on every autosync tick. `source` records which path last
wrote the element. None of it is Excalidraw's, and all of it churns — so a commit that changed
one card's wording arrives as a full-file rewrite, and the diff says nothing about what actually
changed.

Element order is the second half of the problem: the API returns whatever order the `Map`
iterates, which is not stable across runs.

## The fix

`scripts/export-board.mjs` strips the volatile fields and sorts by `id` — a stable key, so an
unrelated edit cannot reshuffle the file. Paint order is unaffected: Excalidraw carries that in
each element's `index`, not in array position.

```
node scripts/export-board.mjs --workspace board-tool --out docs/board.excalidraw
```

Re-running it against an untouched board leaves the file byte-identical. That is the property
worth protecting, and `scripts/check-board-docs.mjs` fails if volatile metadata is ever
committed again.
