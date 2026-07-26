# Docs block

A shape carrying `customData.docKey` has documentation attached to it. Selecting the shape
fetches `GET /api/docs/:key?workspace=...` and renders that markdown in a panel.

```json
{ "type": "rectangle", "customData": { "docKey": "sync-reconciliation" } }
```

The key resolves to `<docsDir>/<key>.md` inside the project, where `docsDir` comes from the
project's own `board.config.json`. `EXCALIDRAW_DOCS_DIR` remains the fallback for single-board
setups, which have no registry to resolve a directory from.

## Finding the key from a click

You rarely click the shape itself — you click its label. `syncSelectedDoc` in
`frontend/src/App.tsx` walks up: from the text element to its container, and from there to the
smallest shape that encloses it. That walk exists because clicking the label instead of the box
was a real defect that compiled perfectly and did nothing.

A multiple selection, or a shape with no `docKey`, opens nothing.

## Rendering

`marked` for markdown, `DOMPurify` for sanitisation, with four states the panel makes visible:
`loading`, `missing`, `error`, `loaded`. A key that does not resolve returns a clean 404 —
`scripts/check-docs-endpoint.mjs` pins that down, along with the traversal guard that rejects
`..` and anything outside the key pattern.

## Known limitation

The panel is Excalidraw's `<Sidebar>`, which CSS pins to the window edge. On a wide board the
selected block can be thousands of pixels from its own documentation. Issue #20 tracks moving
to an overlay positioned with `sceneCoordsToViewportCoords`, the way Excalidraw's own hyperlink
popup already works.
