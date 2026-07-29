# Board sections

A board is one canvas, and a big one is several things at once. This one is two: what the tool
**is** — architecture, blocks, how to try it — and how it **got that way** — the record of every
merge, the traps already paid for, what is still ahead. They stand **side by side**, tops level:
`Project structure | Development`, 64 apart — the same gap that separated them when Development
sat 1892 *below* instead, which is where it was until #217. The board is read across rather than
down, and the reason is that a canvas has width and this one was not using any of it: the two
halves were 1892 units of scrolling apart, and the whole of what the tool is had to go past
before the record of how it got there began.

A section is a shape drawn around one of those halves, carrying the key that reaches it:

```json
"customData": {
  "kind": "board-section",
  "title": "Project structure",
  "hotkeyCode": "KeyP"
}
```

Press `Alt` and that key from anywhere on the page and the viewport scrolls onto the section and
fits it **as far as it can be fitted without being shrunk**, the same movement `Alt+B` makes onto
the GitHub mirror. What that qualification means is the next section.

## How far a section is allowed to shrink

Not below 100%. A fit that takes both axes is decided by whichever is tighter, and on a tall,
narrow board that is always the height: the board was a 1130 x 2732 column then, so against a
maximised 2560 x 1440 display the width fit was 2.27, the height fit 0.48, and the old fit took
0.48 —
drawing the 13px card body at 6px and throwing away every one of the extra horizontal pixels the
display had. The wider the display, the more it discarded. That is #185, reported as the writing
being blurry, which is what canvas glyphs look like below about 10px: no hinting, off the pixel
grid.

So the height no longer shrinks the board past the size it was written at. **A section taller
than the viewport is scrolled, not squeezed** — `Alt+P` on this board now lands at 100% rather
than 0.6, with the section running off the top and bottom of the screen. `Alt+G` is unchanged at
1.4, because the Development section is short enough that the width was already binding.

The width still shrinks it, and the floor is written as `min(1, canvasWidth / contentWidth)` for
that reason (`frontend/src/board-fit.ts`): content wider than the canvas held at 100% would have
to be panned sideways to read one line of text, which is a worse answer than a smaller one.

Which is the number side by side spends, and it is worth knowing how much of it is left. The
board is **2324 x 1978** now: on the 2560 x 1440 display #185 was reported on that is a ~2544
canvas against 2324 of content, so the floor is still 1 and the whole board still opens at the
size it was written at. Another ~220 units of width and it stops being — a whole-board fit goes
width-bound, and #185 arrives again by a different route. So the floor is not left to arithmetic
in a comment: `scripts/check-board-side-by-side-browser.mjs` opens the real board on a 2560-wide
canvas and measures the zoom **off the screenshot** — the distance in painted pixels between the
two sections' outer borders, over the width they are authored at — rather than reading back the
number the page believes it is drawing at.

Two consequences worth knowing before they surprise somebody. A section that overflows is
**centred** in what overflows, so `Alt+P` lands in the middle of the section rather than at its
title — Excalidraw's `scrollToContent` centres the bounds it is given, and taking the top instead
would mean computing the whole camera here and giving up the animated pan. And the zoom a reader
sets by hand is now kept per board in `localStorage`, beside the theme and the terminal's
geometry, so a correction survives a reload; a board with a remembered camera is put back at it
instead of being fitted at all.

## Why the key is on the shape

`Alt+B` and `Alt+T` are constants in `frontend/src/App.tsx`, and they are right to be: a mirror
and a terminal are features of every board this canvas opens. A section is not. "Project
structure" and "Development" are *this* project's cut of *this* project's documentation, and a
third and fourth constant would have made the feature wrong for every other board the moment
someone drew their sections differently — the same reasoning that keeps the implement agent's
prompt free of this repository's workflow.

So the board declares its own navigation, and nothing has to be deployed to change it. Retitle a
section, or give it a different key, and the binding follows on the next render. Authored
`customData` has survived the sync, the export and the library round trip since #3; `docKey`
proves it every time a card is clicked.

`src/core/board-sections.ts` is the resolver, and it is pure so that it can be checked without a
browser — `scripts/check-board-map.mjs` runs it against boards built in memory.

## What a board cannot claim

Two keys are already taken: `KeyB` by the mirror and `KeyT` by the terminal. A section asking for
either is **ignored**, not honoured — a data file that could silently break the terminal would be
a bad trade for a shorter rule. Two sections asking for the same key resolve by where they sit —
`(a.y - b.y) || (a.x - b.x)`, so the one higher on the board, and between two level with each
other the leftmost; deciding it by array order would make the winner change when nothing on the
board did. Since #217 this board's two *are* level, so it is the `x` half of that tie-break that
would decide here — worth knowing before a third section is drawn, and asserted by
`scripts/check-board-side-by-side-browser.mjs` rather than left to be noticed. A `hotkeyCode`
that is not a `KeyboardEvent.code` — `"Alt+P"`, `""` — is ignored too.

Every rejected claim is printed once to the console, because a key that is silently doing nothing
looks like a broken canvas rather than a board that asked for something it cannot have.

## The guards

Identical to `Alt+B`'s, and for the same reasons:

- the listener is on `window`, because Excalidraw never sees a key pressed outside its canvas and
  the point of the key is to work from anywhere on the page;
- matched on `event.code`, so a keyboard layout where `Alt` produces a different character still
  reaches the same section;
- it stands down while a `TEXTAREA`, an `INPUT` or a `contentEditable` has focus, and while
  Excalidraw reports an `editingTextElement`. Typing a title into a card must not jump the
  viewport out from under the cursor;
- **except when the `TEXTAREA` is the terminal**, which is #177. A focused xterm is a focused
  `TEXTAREA` — the emulator reads the keyboard through a hidden `.xterm-helper-textarea` — so
  until then a reader with the terminal focused could not navigate the board at all, and the
  documented way back was to click the canvas first. The section keys now reach the board from
  inside a focused shell, and the shell is not sent them: `frontend/src/board-hotkeys.ts` holds
  the rule all four listeners read, and [terminal.md](terminal.md) has the other two layers it
  took and what the shell gives up for it;
- `Ctrl` or `Meta` held means it is not this chord. That also leaves AltGr alone, which arrives
  as `Ctrl+Alt` on several layouts and is somebody typing a `@`.

`Alt+D` was the obvious key for **Development** and is not the one it got. On Windows, `Alt+D`
focuses Chrome's and Firefox's address bar, and whether `preventDefault` suppresses a browser
accelerator is not a claim this repository accepts from a compile — a CDP-injected key event goes
straight to the renderer, so an automated check would pass whether or not a real keypress was
stolen. `Alt+G` is free, and it is one field on one shape if the maintainer disagrees.

## Keeping both halves true

The sections are only worth drawing if they stay right, so the rule is in
[CLAUDE.md](../CLAUDE.md): an implementation is not finished until
[development-log.md](development-log.md) has its dated entry naming the issue and the pull
request, and until the structure map reflects any architecture or feature change — a file, a
route, a block kind or a feature added or removed.

`scripts/check-board-map.mjs` is what makes that a rule rather than a hope. It fails on a board
with fewer than two marked sections, on a duplicate or reserved key, on a card with a document
that sits outside every section, on a tracked `docs/*.md` no card points at, and on a merged pull
request with no entry in the log.

`scripts/check-board-side-by-side-browser.mjs` holds the arrangement: that the two sections still
share a top edge and do not overlap, that Project structure still ends before Development begins,
that nothing was left behind on the old canvas when the section moved, and — in a real Chrome, on
the display #185 was reported on — that each key still lands on its own section and the whole
board is still painted at 100%.
