# Collapsible image

An image block that shrinks to a thumbnail and expands back, so a board can carry screenshots
and diagrams without a single large image dominating the layout.

State lives on the element:

```json
{ "customData": { "collapsed": true, "fullSize": { "width": 900, "height": 600 } } }
```

## Why `fullSize` is stored before shrinking

Because the expanded size cannot be recovered afterwards. Once the shape has been resized down,
the original width and height are gone — the only honest way to restore them is to have written
them down first. Guessing from the image's intrinsic dimensions gets a shape the user never
chose, and any aspect-ratio reconstruction breaks the moment someone resizes the collapsed
thumbnail.

So the block writes `fullSize` at the moment it collapses, and reads it back on expand.
Collapsing shrinks to a fixed 48 scene units tall, keeping the current aspect ratio.

The fallback when `fullSize` is absent is the element's own current size, which is the right
answer on the way *down* — that is exactly what gets stashed — and a no-op on the way back up.
A block collapsed by some older path, with no `fullSize` recorded, therefore expands to the
size it already has. Nothing throws; nothing is restored either.

## Where it lives

The toggle is in `DocsPanel.tsx` (`onToggleCollapse`), because that panel is already what
opens for a selected shape — a block does not need its own floating control.

Checked by `scripts/check-collapsible-image.mjs`.
