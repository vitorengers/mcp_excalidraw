/**
 * What the terminal's font really measures, asked of the browser that resolved it.
 *
 * The one thing about the block's grid that arithmetic cannot answer. `terminalCell()` needs
 * the font's own line box to work out a row, because that is what xterm multiplies its
 * `lineHeight` by — and the line box belongs to whichever member of `TERMINAL_FONT_FAMILY`
 * this machine actually has. A second measured constant would have been no more honest than
 * the first: the stack resolves differently per machine, and the metrics come back as whole
 * pixels, so the ratio is a staircase rather than a line.
 *
 * Deliberately the same route xterm's own `TextMetricsMeasureStrategy` takes — `measureText`
 * on a 2d context, `fontBoundingBoxAscent + fontBoundingBoxDescent` — so what this reads is
 * the number the emulator will be dividing its screen by, not an estimate of it.
 *
 * In the browser only. `src/core/terminal-block.ts` stays arithmetic, so both it and the
 * checks that import it keep working with no DOM at all; a caller that has nothing to pass
 * gets `TERMINAL_LINE_BOX` and a row that is never shorter than the real one.
 */

import { TERMINAL_FONT_FAMILY } from '../../src/core/terminal-block'

/** One context for the page. Measuring is cheap; making a canvas per call is not. */
let context: CanvasRenderingContext2D | null | undefined

function measuringContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context
  try {
    context = document.createElement('canvas').getContext('2d')
  } catch {
    context = null
  }
  return context
}

/**
 * The font's line box at this size, in CSS pixels, or `null` if the browser will not say.
 *
 * Not cached by size. The answer can change under the page — a web font finishing, a font
 * installed and the stack resolving further up it — and the grid is recomputed only when the
 * reader drags a corner or presses a button, which is rare enough that a `measureText` costs
 * nothing. A cached first answer, taken before the font settled, would be wrong for the rest
 * of the session and there would be nothing to invalidate it.
 */
export function terminalLineBox(fontSize: number): number | null {
  const size = Number(fontSize)
  if (!Number.isFinite(size) || size <= 0) return null

  const ctx = measuringContext()
  if (!ctx) return null

  ctx.font = `${size}px ${TERMINAL_FONT_FAMILY}`
  const metrics = ctx.measureText('W')
  const ascent = metrics.fontBoundingBoxAscent
  const descent = metrics.fontBoundingBoxDescent
  // Older browsers report neither, and xterm falls back to measuring a span there. Rather
  // than a third way of measuring, that is the case `TERMINAL_LINE_BOX` exists for.
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) return null

  const box = ascent + descent
  return box > 0 ? box : null
}
