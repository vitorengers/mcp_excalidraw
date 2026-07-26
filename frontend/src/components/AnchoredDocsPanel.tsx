import React from 'react'
import { DocsPanelBody, DocsPanelBodyProps } from './DocsPanel'
import {
  placeCard,
  cardHeightFor,
  Rect,
  Size
} from '../../../src/core/anchored-placement'

/** Fixed, in screen pixels: the card is a reading column, not a shape on the board. */
const CARD_WIDTH = 360
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
  if (!anchor) return null

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
      <button
        type="button"
        className="docs-card__close"
        onClick={onClose}
        aria-label="Close documentation"
        title="Close"
      >
        ×
      </button>
      <DocsPanelBody {...body} />
    </div>
  )
}
