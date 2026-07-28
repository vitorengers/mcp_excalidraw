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

`scripts/export-board.mjs` strips the volatile fields and sorts by `index`, with the `id`
breaking ties.

```
node scripts/export-board.mjs --workspace board-tool --out docs/board.excalidraw
```

Re-running it against an untouched board leaves the file byte-identical. That is the property
worth protecting, and `scripts/check-board-docs.mjs` fails if volatile metadata is ever
committed again.

## The sort key changed in #151, and the old reasoning was wrong

It used to sort by `id` alone, on the argument written here: a stable key, so an unrelated edit
cannot reshuffle the file, and *paint order is unaffected because Excalidraw carries that in each
element's `index`, not in array position*.

The second half of that is false, and the board paid for it. Excalidraw treats fractional indices
as valid only while they **increase along the array**. Handed an array in id order it reads them
as broken, regenerates them from the array order, and paints in that order instead — so a card's
title whose id happened to sort before its rectangle's was painted first and then covered by the
opaque rectangle it belongs to. Twenty pieces of text were buried that way and five cards drew as
empty boxes: present in the file, unreadable on the canvas, and green in every check the
repository had. It is what the screenshot behind #151 was showing, and the reason a
board-shaped defect can survive a file-shaped audit.

Sorting by `index` costs nothing that mattered: it only changes when something is genuinely
restacked, and the `id` still decides between elements that share one.
`scripts/check-board-z-order.mjs` fails on a board where the indices do not increase, or where a
piece of text is listed before a filled shape that covers it.
