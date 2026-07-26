# Open

## #20 — dock the documentation panel to the block

Today the panel is Excalidraw's `<Sidebar>`, which CSS pins to the window edge: `position:
absolute; top: 0; bottom: 0; right: 0`. There is no anchoring prop — `docked` only decides
whether the panel pushes the canvas or floats over it. On a wide board the selected block can
sit thousands of pixels from its own documentation.

So the answer is not to adjust the sidebar but to replace it with an overlay positioned in
viewport coordinates, the way Excalidraw's own hyperlink popup already works:
`getElementAbsoluteCoords` plus `sceneCoordsToViewportCoords`, minus `appState.offsetLeft/Top`,
returning nothing while the element is being dragged, resized or rotated.

The open question the issue records is whether the anchored card **replaces** the sidebar or
coexists with it. #3 explicitly asked for a panel that would not cover the drawing, and an
anchored card necessarily covers part of the board.

## #21 — keep every development artifact in English

The convention was never enforced, and it leaked twice: Portuguese fixtures in the check
scripts, and issue #20 written entirely in Portuguese by the issue agent itself.

The interesting part is the cause. The observation that produced #20 is in English — the agent
did not mirror it. The prompt sends the agent to read the project's own documentation before
proposing a solution, that project documents in Portuguese, and nothing in the prompt fixed the
output language. It took the language from what it had just read.

PR #22 adds the directive and a scanner, `scripts/check-english-only.mjs`, that fails on
Portuguese in tracked source, scripts, skills and Markdown.
