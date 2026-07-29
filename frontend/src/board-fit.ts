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
 * board was a 1130 x 2732 column when #185 was reported: against a maximised 2560 x 1440
 * display the width fit was 2.27 and the height fit 0.48, and the fit took 0.48. (It is
 * 2324 x 1978 since #217 put its two sections side by side, which spends width against the
 * floor below rather than height — still 1 on that display, and checked there.)
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

/**
 * The four edges a fit is told to keep clear of.
 *
 * Excalidraw's own `Offsets`, spelled out: every edge present, because everything here
 * computes with all four and an optional number would only mean writing `?? 0` at each use.
 */
export interface FitOffsets {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * The breathing room Excalidraw leaves around its own fits: `--editor-container-padding`.
 *
 * Its `getEditorUIOffsets` adds this to each edge, and matching it is the point — a landing
 * computed here should look like a landing Excalidraw computed, not like a different rule
 * that happens to be applied in the same place.
 */
export const CHROME_PADDING = 16

/** Enough of a `DOMRect` to place an edge by. */
interface EdgeRect {
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

/** A `display: none` node still answers `getBoundingClientRect`, with zeros. */
const laidOut = (rect: EdgeRect | null): EdgeRect | null =>
  rect && (rect.width > 0 || rect.height > 0) ? rect : null

/**
 * What Excalidraw's own floating chrome covers, as offsets into the canvas.
 *
 * Excalidraw draws its menus *over* the canvas — `--zIndex-layerUI: 4` above
 * `--zIndex-canvas: 1` — so content fitted into the full canvas box lands underneath them.
 * Its hamburger and its properties island sit top-**left**, which is the corner the mirror
 * is drawn in, so this is not a theoretical overlap.
 *
 * The same three nodes its own `getEditorUIOffsets` measures, and the same padding, with one
 * difference that matters here: those rects are read **relative to the canvas box** rather
 * than to the browser window. Upstream can take `toolbar.bottom` raw because its container
 * starts at the top of the window; this one sits below a page header and a tab strip, and
 * charging their height to the canvas would reserve a band that is not on it.
 *
 * `Hide Menus` needs no branch. It is `display: none` on the toolbar and on the island
 * (`frontend/index.html`), and a hidden node's rect is all zeros — so the measurement
 * collapses to the padding on its own, which is what a check with the menus hidden is
 * asserting rather than a flag being read correctly.
 *
 * Left-to-right only, where upstream swaps left and right for RTL locales: the board is
 * English throughout (`CLAUDE.md`), and a swap nothing here can reach would be untested code.
 */
export const measureBoardChrome = (container: Element | null): FitOffsets => {
  const padded = {
    top: CHROME_PADDING,
    right: CHROME_PADDING,
    bottom: CHROME_PADDING,
    left: CHROME_PADDING
  }
  if (!container) return padded
  const box = container.getBoundingClientRect()
  const rectOf = (selector: string): EdgeRect | null =>
    laidOut(container.querySelector(selector)?.getBoundingClientRect() ?? null)

  const toolbar = rectOf('.App-toolbar')
  const properties = rectOf('.App-menu__left')
  const sidebar = rectOf('.sidebar')

  return {
    top: Math.max(toolbar ? toolbar.bottom - box.top : 0, 0) + CHROME_PADDING,
    right: Math.max(sidebar ? box.right - sidebar.left : 0, 0) + CHROME_PADDING,
    bottom: CHROME_PADDING,
    left: Math.max(properties ? properties.right - box.left : 0, 0) + CHROME_PADDING
  }
}

// Excalidraw's zoom arithmetic, restated. Read off @excalidraw/excalidraw 0.18's
// `zoomToFitBounds` and the helpers it calls, because the landing below has to know which
// zoom the fit is about to choose *before* it chooses it — the overflow to correct for is
// `contentHeight x zoom`, and there is no way to ask for the number afterwards without
// giving up the animated pan and driving the camera by hand.
const ZOOM_STEP = 0.1
const MIN_ZOOM = 0.1
const MAX_ZOOM = 30

/** `roundToStep(value, ZOOM_STEP, 'floor')`: a fit is rounded *down* to a tenth. */
const flooredToStep = (zoom: number): number => {
  const factor = 1 / ZOOM_STEP
  return Math.floor(zoom * factor) / factor
}

/** `getNormalizedZoom`: `clamp(round(zoom, 6), MIN_ZOOM, MAX_ZOOM)`. */
const normalizedZoom = (zoom: number): number => {
  const multiplier = 10 ** 6
  const rounded = Math.round((zoom + Number.EPSILON) * multiplier) / multiplier
  return Math.min(Math.max(rounded, MIN_ZOOM), MAX_ZOOM)
}

/**
 * The zoom `scrollToContent({ fitToViewport: true, minZoom })` will land on.
 *
 * Both axes fitted into what the offsets leave, rounded down to a tenth, then held up by the
 * floor. The floor is the half that produces an overflow: where the height is the tighter
 * fit, the clamp puts the zoom back above it, and the content is then taller than the canvas
 * it is being fitted into.
 */
export const fitZoom = (
  content: { width: number; height: number },
  canvas: { width: number; height: number },
  offsets: FitOffsets,
  minZoom: number
): number => {
  const usableWidth = canvas.width - offsets.left - offsets.right
  const usableHeight = canvas.height - offsets.top - offsets.bottom
  const both = Math.min(usableWidth / content.width, usableHeight / content.height)
  return normalizedZoom(Math.max(flooredToStep(both), minZoom))
}

/**
 * Where `Alt+B`, `Alt+P` and `Alt+G` put the shapes they are given.
 *
 * Two rules, and the second is #232.
 *
 * **The chrome is reserved.** `measureBoardChrome` above; the fit happens in what is left of
 * the canvas, and the camera is shifted so the content sits in that box rather than under
 * the toolbar.
 *
 * **A target taller than that box is top-aligned, not centred.** Excalidraw centres the
 * bounds it is given, which is right while they fit and wrong the moment they do not: the
 * overflow is split half above and half below, and the half above is the mirror's column
 * headers and its title — the top of the thing the key was pressed to read. That is the Mac
 * report in #232, and nothing about it is platform-specific; it is canvas height alone, and
 * a full `Todo` column is taller than a laptop canvas and shorter than a maximised desktop
 * one, which is the whole of "on Windows the behavior is different".
 *
 * `docs/board-sections.md` rejected top-alignment once, on the grounds that it meant
 * computing the whole camera here and giving up the animated pan. It does not:
 * `centerScrollOn` shifts the centre by `offsets.top / 2 / zoom`, so a `top` of
 * `reserved + overflow` lands the content's top edge exactly on `reserved` — through the
 * supported `canvasOffsets` argument, with `animate: true` untouched.
 *
 * Growing `top` also shrinks the height the fit is computed against, which would be circular
 * if it could change the answer. It cannot: an overflow exists only where the floor has
 * already overruled the height fit, and taking more height away only pushes the height fit
 * further below a floor that is already winning.
 *
 * The floor itself is still measured against the **whole** canvas width, not the width the
 * offsets leave. It is a statement about legibility — the size the board was written at —
 * and reserving room for a menu is not a reason to draw the board smaller than that. Chrome
 * moves the camera; it does not lower the floor, and #185's number is unchanged.
 */
export const boardFitOptions = (
  elements: readonly ExcalidrawElement[],
  canvas: { width: number; height: number },
  chrome: FitOffsets
): { minZoom: number; canvasOffsets: FitOffsets } => {
  const minZoom = legibleFitFloor(elements, canvas.width)
  if (elements.length === 0) return { minZoom, canvasOffsets: chrome }

  const [minX, minY, maxX, maxY] = getCommonBounds(elements)
  const content = { width: maxX - minX, height: maxY - minY }
  if (!Number.isFinite(content.width) || content.width <= 0) return { minZoom, canvasOffsets: chrome }
  if (!Number.isFinite(content.height) || content.height <= 0) return { minZoom, canvasOffsets: chrome }

  const zoom = fitZoom(content, canvas, chrome, minZoom)
  const overflow = content.height * zoom - (canvas.height - chrome.top - chrome.bottom)
  if (!(overflow > 0)) return { minZoom, canvasOffsets: chrome }
  return { minZoom, canvasOffsets: { ...chrome, top: chrome.top + overflow } }
}
