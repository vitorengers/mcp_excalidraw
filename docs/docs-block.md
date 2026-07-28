# Docs block

A shape carrying `customData.docKey` has documentation attached to it. Selecting the shape
fetches `GET /api/docs/:key?workspace=...` and renders that markdown in a panel.

```json
{ "type": "rectangle", "customData": { "docKey": "sync-reconciliation" } }
```

The key resolves to `<docsDir>/<key>.md` inside the project, where `docsDir` comes from the
project's own `board.config.json`. `EXCALIDRAW_DOCS_DIR` remains the fallback for single-board
setups, which have no registry to resolve a directory from.

A project registered through the `+` is given `docsDir` when it actually has a `docs/` folder —
read from disk, never guessed — because `docsDir` is the only route documentation has, and a
config without it is a board on which every key answers 404. A project that keeps its documents
somewhere else gets the blank and fills it in **Docs folder** in the project settings. The
seeding happens when the config is created and at no other time: a project already registered
keeps its config exactly as it is, absence included.

## Documentation the tool owns

Some keys belong to a block this server draws rather than to the board it is drawn on. The
project mirror is generated onto every project that names a `githubProject`, always carrying
`docKey: "project-board"` — and that key used to resolve inside the *mirrored* project, where
the document has no reason to exist, so the mirror on every board but this one read as
undocumented. Those keys are listed in `TOOL_DOC_KEYS` in `src/server.ts` and resolve against
the tool's own `docs/`, whichever board is asking.

## Finding the key from a click

You rarely click the shape itself — you click its label. `syncSelectedDoc` in
`frontend/src/App.tsx` walks up: from the text element to its container, and from there to the
smallest shape that encloses it. That walk exists because clicking the label instead of the box
was a real defect that compiled perfectly and did nothing.

A multiple selection, or a shape with no `docKey`, opens nothing.

## Rendering

`marked` for markdown, `DOMPurify` for sanitisation, with five states the panel makes visible:
`loading`, `missing`, `no-docs-dir`, `error`, `loaded`. A key that does not resolve returns a
clean 404 — `scripts/check-docs-endpoint.mjs` pins that down, along with the traversal guard
that rejects `..` and anything outside the key pattern.

**Two of those 404s are different problems**, and the body says which: `code` is `no-doc` for a
key nobody has written a document for, and `no-docs-dir` for a board that has no docs directory
at all, where no key could have resolved. The panel used to map both to `missing` and throw the
body away, so a board one setting away from working reported `No document yet for <key>` and
nothing pointed at the setting. It now names **Docs folder** in the project settings, behind the
gear on the project's own tab. `scripts/check-docs-directory.mjs` covers the route and
`scripts/check-docs-directory-browser.mjs` the sentence on screen.

## Where the card sits

Beside the block, not at the window edge. The panel used to be Excalidraw's `<Sidebar>`, which
CSS pins to the right of the window with no prop to move it — on a wide board the selected block
could sit thousands of pixels from its own documentation, and the eye had to cross the whole
screen to connect the two.

It is now a DOM overlay positioned with `sceneCoordsToViewportCoords`, the same conversion
Excalidraw's own hyperlink popup uses, from the axis-aligned bounds `getCommonBounds` gives for
the shape. It anchors to the shape that **holds** the `docKey`, not to whatever was clicked:
anchoring to a label would put the card beside the text rather than beside the box.

`src/core/anchored-placement.ts` decides where. Sides are tried right, left, below, above, and
the first with room wins; on the horizontal sides the card is aligned with the top of the shape
and slid vertically to stay on screen. When no side has room — a shape filling the viewport, or
a viewport smaller than the card — it is forced on screen and reports `clamped`, because a card
hanging off the edge is unreadable while one that overlaps is merely in the way. The arithmetic
lives in its own module so `scripts/check-anchored-placement.mjs` can check the edge cases
without driving a browser.

Two consequences worth stating:

- **The card is sized in screen pixels**, not scene units. At 40% zoom a card that scaled with
  the board would be unreadable, and reading is the whole point.
- **It never reaches an export.** It is a DOM overlay rather than a scene element, and
  `exportToBlob` / `exportToSvg` render from elements — so a PNG or SVG of the board has the
  shapes and none of the cards.

While a shape is dragged, resized or rotated the card hides rather than chasing the pointer —
the hyperlink popup does the same. It hides rather than unmounts, so a nudge to the block does
not throw away the reader's scroll position and refetch the document.
