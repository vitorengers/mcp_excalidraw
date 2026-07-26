import React from 'react'
import { DocsPanelBody, DocsPanelBodyProps } from './DocsPanel'
import {
  placeCard,
  cardHeightFor,
  Rect,
  Size
} from '../../../src/core/anchored-placement'

/**
 * Fixed, in screen pixels: the card is a reading column, not a shape on the board.
 *
 * 720 rather than the 360 it started at — these cards routinely hold a whole GitHub
 * issue now, and at half this width a body of headings, lists and inline code reads as
 * a ribbon. A wider card fits to the right of a block less often, which is what the
 * placement fallbacks are for.
 */
const CARD_WIDTH = 720
const MAX_CARD_HEIGHT = 460

export interface AnchoredDocsPanelProps extends DocsPanelBodyProps {
  /** The shape's bounds in viewport coordinates, or null when nothing is anchored. */
  anchor: Rect | null
  /** The canvas area, which is what the card must stay inside. */
  viewport: Size
  /** True while the shape is being dragged, resized or rotated. */
  suppressed: boolean
  onClose: () => void
}

/**
 * The documentation for a shape, shown next to that shape.
 *
 * This replaced Excalidraw's `<Sidebar>`, which CSS pins to the window edge — on a wide
 * board the selected block could sit thousands of pixels from its own documentation, and
 * there is no prop to move it, so the panel had to stop being a sidebar.
 *
 * Sized in screen pixels rather than scene units: at 40% zoom a card that scaled with the
 * board would be unreadable, and the point of the card is reading. It therefore does not
 * belong to the scene at all — it is a DOM overlay, which is also why it never appears in
 * a PNG or SVG export.
 *
 * Hidden rather than unmounted while the shape is being moved: unmounting would throw away
 * the reader's scroll position and refetch the document every time the block is nudged.
 */
export const AnchoredDocsPanel: React.FC<AnchoredDocsPanelProps> = ({
  anchor, viewport, suppressed, onClose, ...body
}) => {
  // The anchor says *where* a card would go; it must not also decide *whether* there is
  // one. Letting it decide left an empty card with a close button on screen after the
  // shape was deselected — a shell with nothing in it.
  const hasSomethingToShow = Boolean(body.docKey || body.issue || body.collapsible)
  if (!anchor || !hasSomethingToShow) return null

  const height = cardHeightFor(viewport, MAX_CARD_HEIGHT)
  const placement = placeCard(anchor, { width: CARD_WIDTH, height }, viewport)

  return (
    <div
      className="docs-card"
      data-side={placement.side}
      data-clamped={placement.clamped ? 'true' : 'false'}
      style={{
        left: `${placement.left}px`,
        top: `${placement.top}px`,
        width: `${CARD_WIDTH}px`,
        maxHeight: `${height}px`,
        visibility: suppressed ? 'hidden' : 'visible'
      }}
      // The canvas is underneath. Without this a scroll inside the card zooms the board,
      // a click inside it starts a selection, and a keystroke reaches Excalidraw's
      // single-letter tool shortcuts.
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {/* A row of its own rather than a button floated over the content: absolutely
          positioning it meant nothing else could know it was there, and it landed on
          top of the first full-width control in the card. */}
      <div className="docs-card__header">
        <button
          type="button"
          className="docs-card__close"
          onClick={onClose}
          aria-label="Close documentation"
          title="Close"
        >
          ×
        </button>
      </div>
      <DocsPanelBody {...body} />
    </div>
  )
}
