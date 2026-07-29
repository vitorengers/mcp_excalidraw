# Board sections

A board is one canvas, and a big one is several things at once. This one is two: what the tool
**is** — architecture, blocks, how to try it — and how it **got that way** — the record of every
merge, the traps already paid for, what is still ahead. Scrolling between them is the whole
distance of the board.

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
narrow board that is always the height: this board is 1130 x 2732, so against a maximised
2560 x 1440 display the width fit is 2.27, the height fit is 0.48, and the old fit took 0.48 —
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
a bad trade for a shorter rule. Two sections asking for the same key resolve to the one higher on
the board, and the other is ignored; deciding it by array order would make the winner change when
nothing on the board did. A `hotkeyCode` that is not a `KeyboardEvent.code` — `"Alt+P"`, `""` —
is ignored too.

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
  the rule every one of these listeners reads, and [terminal.md](terminal.md) has the other two layers it
  took and what the shell gives up for it;
- `Ctrl` or `Meta` held means it is not this chord. That also leaves AltGr alone, which arrives
  as `Ctrl+Alt` on several layouts and is somebody typing a `@`.

`Alt+D` was the obvious key for **Development** and is not the one it got. On Windows, `Alt+D`
focuses Chrome's and Firefox's address bar, and whether `preventDefault` suppresses a browser
accelerator is not a claim this repository accepts from a compile — a CDP-injected key event goes
straight to the renderer, so an automated check would pass whether or not a real keypress was
stolen. `Alt+G` is free, and it is one field on one shape if the maintainer disagrees.

## Subsections, and one step between them

A section is a half of the board. Its **subsections** are the parts of that half, and
`Alt+Left` / `Alt+Right` walk between them:

```json
"customData": {
  "kind": "board-subsection",
  "title": "Compliance"
}
```

A subsection carries **no key of its own**, and that is the feature rather than an omission.
Parts are read one after another — that is what makes them parts of one thing — so what they
need is a step, not a name to be summoned by. Twelve chords for a board with twelve parts is a
keyboard nobody learns; two that always mean *next* and *previous* is one everybody already has.

**A part belongs to the smallest section that encloses it.** Nothing points at anything: the
board declares its nesting by drawing it, which is the containment `check-board-map.mjs` has
used since it was written to decide whether a card is inside a section. A parent id would be a
second copy of a fact the canvas already holds, and the two would drift the first time somebody
dragged a shape.

**The order is where the parts sit, not a number.** A `customData.order` is read and decides
nothing; where the two disagree the drawing wins and the disagreement is printed, the same way
a rejected hotkey claim is. One of them has to lose, or moving a part on screen would silently
do nothing — and a number in a file nobody looks at cannot outrank the position of the thing
being looked at. `order` is therefore optional and redundant, kept only because a board that
already writes it is not wrong, merely repeating itself.

Four questions this left open, answered here rather than in the component, so that
`scripts/check-board-subsections.mjs` can hold them:

| Question | Answer | Why |
| --- | --- | --- |
| Wrap at the last part, or stop? | **Stop** | A section is a short walk. Wrapping makes its end the one boundary the reader cannot feel, and `Alt+P` / `Alt+G` already say which half they landed in. |
| The viewport is on no section | **The nearest one** | A key that does nothing because the reader is between two things is a key they stop trusting. |
| The viewport is inside the section but on no part | **The first press lands, it does not step** | It puts the reader on the walk; the second press moves them along it. Stepping from a part nobody was on would skip one for no visible reason. |
| A key per subsection? | **No** | See above: the step is the point. A part that deserves its own key is a section. |

`src/core/board-subsections.ts` is the resolver, and it is pure for the reason the section one
is: a hotkey that does nothing compiles perfectly. It decides which section the viewport is on,
which part of it, and where one step lands; the component is left with `scrollToContent`.
`scripts/check-board-subsections.mjs` runs it against boards built in memory and
`scripts/check-board-subsections-browser.mjs` runs the keys against a real Chrome.

The guards are the section keys' guards, unchanged, including the xterm exception. One rule is
new and it is about the browser rather than about the board: **the step swallows the key even
when it has nowhere left to go.** At the end of a section `Alt+Right` re-fits the last part
rather than doing nothing, because doing nothing on Windows means the browser navigating
Forward out of the page. A board that draws no parts at all resolves to nothing, takes neither
key, and leaves Back and Forward exactly where they were — which is every board that never
draws one.

### The one claim that was measured rather than reasoned

On Windows and Linux `Alt+Left` and `Alt+Right` **are** Back and Forward, which is the same
class of problem as `Alt+D` above and would have been rejected the same way. It is not, because
this time it was measured: `scripts/check-alt-arrow-accelerator.mjs` drives a visible Chrome and
sends the chord through Windows itself — `SendInput`, past the accelerator table, the way a
reader's own keypress arrives — with the control that makes the answer worth having, a page that
does *not* listen and must therefore navigate.

Measured on Windows 11, Chrome, 2026-07-29: an unlistening page goes Back on `Alt+Left` and
Forward on `Alt+Right`; a page that calls `preventDefault()` sees both keydowns and goes
nowhere. Chromium's *reserved* accelerators — the ones handled before the renderer is
consulted — do not include Back and Forward, so the page is offered them first and keeps them.
`Alt+D` is on the other side of that line, which is why one of these keys is available and the
other was not.

Three things that made the measurement wrong before it was right, all worth knowing before
anyone repeats it:

- **A key injected without a scan code arrives with an empty `KeyboardEvent.code`.** Chrome
  reads `code` from the scan code, so `wVk` alone is not a keypress; the arrows also need
  `KEYEVENTF_EXTENDEDKEY`, or they are the numeric keypad's.
- **A second process cannot send the chord the first one raised the window for.** Injected input
  goes to whatever holds the foreground at that instant, and a PowerShell console taking the
  foreground as it starts receives the chord itself — which looks exactly like the browser
  eating it.
- **`location.href = …` is not a history entry the browser's Back will cross.** An entry pushed
  by a script in a document that never saw a user gesture is skippable under Chrome's
  history-manipulation intervention: `history.back()` still crosses it, the accelerator steps
  straight over it, and the control fails for a reason that has nothing to do with the chord.

## The default for a new project

`vitorengers/farol#6` asked for the two-section cut to be every project's default, and #184
removed what made that impossible — a board no longer comes up empty when a file is there. So
this is a decision rather than a blocker, and the decision is **a documented convention, not a
board this server writes**.

Frontend constants were already rejected, above, and nothing here changes that. What is new is
the argument against the other option. A `board.config.json` is written for a project that has
none, but only what can be verified — `docsDir` is stat-ed rather than assumed, and a project
already registered is never rewritten to repair it. A starter *board* is different in kind: it
is content, not configuration. It would arrive with two titles this tool chose, in a language
this tool chose, cutting a project's documentation the way this project cuts its own — which is
the same mistake as `Alt+P` being a constant, one layer up, and the same mistake as an issue
arriving in English in a Portuguese repository. A project would then have to undo a drawing and
a config field before it could draw its own.

So the convention is the shape, and the shape is what is written down. A project that wants it
draws two rectangles around its two halves and gives each one a `hotkeyCode`; if it cuts either
half further, it draws those parts too and gets the arrows for free. Both are `customData` on
shapes it already owns, nothing has to be deployed, and a project that wants a different cut is
not arguing with a default it did not choose.

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

It says nothing about subsections, and that is deliberate: this board draws none. The rule is
that both halves stay true, not that every board is cut the same depth.
