import { getCommonBounds } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'

/**
 * The zoom a board is written at.
 *
 * Every size on a board — a 13px card body, a 19px card title — was chosen by somebody
 * looking at the canvas at 100%. Drawing it at less than that is drawing it at less than the
 * size it was written for, and canvas glyphs have no hinting: at 6 CSS px they land off the
 * pixel grid and read as blurry rather than as small, which is how #185 arrived.
 */
export const AUTHORED_ZOOM = 1

/**
 * The zoom a fit is not allowed to go below, for content of this width.
 *
 * `scrollToContent({ fitToViewport: true })` fits **both** axes — it takes
 * `min(canvasWidth / contentWidth, canvasHeight / contentHeight)` — so on a tall, narrow
 * board the height decides, and the wider the display the more of it is thrown away. This
 * board is 1130 x 2732: against a maximised 2560 x 1440 display the width fit is 2.27 and the
 * height fit is 0.48, and the fit took 0.48.
 *
 * So the height is no longer allowed to shrink the board past the size it was written at.
 * A board taller than the viewport is **scrolled**, not squeezed.
 *
 * The width still can, and that is the whole of the `min`: content wider than the canvas
 * fitted at 100% would have to be panned sideways to read one line of text, which is a worse
 * answer than a smaller one. So the floor is the width fit whenever the width fit is the
 * tighter of the two — never a fixed number that a narrow window cannot honour.
 *
 * Bounds come from Excalidraw's own `getCommonBounds`, which is the same function its fit
 * calls: a floor measured off `x + width` would disagree with the fit on a rotated shape or a
 * curve, and disagreeing upward is content pushed off the sides.
 */
export const legibleFitFloor = (
  elements: readonly ExcalidrawElement[],
  canvasWidth: number
): number => {
  if (elements.length === 0 || !Number.isFinite(canvasWidth) || canvasWidth <= 0) {
    return AUTHORED_ZOOM
  }
  const [minX, , maxX] = getCommonBounds(elements)
  const width = maxX - minX
  if (!Number.isFinite(width) || width <= 0) return AUTHORED_ZOOM
  return Math.min(AUTHORED_ZOOM, canvasWidth / width)
}
