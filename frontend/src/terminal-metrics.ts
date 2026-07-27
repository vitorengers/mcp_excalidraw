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

import { TERMINAL_FONT_FACE, TERMINAL_FONT_FAMILY } from '../../src/core/terminal-block'

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

/**
 * The font's advance width at this size, in CSS pixels, or `null` if it cannot be measured.
 *
 * The other half of a cell, and a measurement for the same reason the line box is one: it
 * belongs to whichever member of `TERMINAL_FONT_FAMILY` this browser resolved, and since
 * #115 that is a **web font**, so the answer changes under the page when the face lands. The
 * primary face measures 0.55 per font pixel and the stack behind it 0.586 — a five per cent
 * difference, which is five columns on a default block.
 *
 * xterm does nothing to this number: `device.cell.width` *is* the measured advance, and
 * `css.cell.width` divides it straight back out. So unlike the row, what is measured here is
 * what the emulator will draw with rather than the input to a formula.
 *
 * Any glyph would do — the face is monospaced, which is the whole reason it can drive a
 * terminal — and `W` is the one xterm's own `TextMetricsMeasureStrategy` asks about.
 */
export function terminalAdvance(fontSize: number): number | null {
  const size = Number(fontSize)
  if (!Number.isFinite(size) || size <= 0) return null

  const ctx = measuringContext()
  if (!ctx) return null

  ctx.font = `${size}px ${TERMINAL_FONT_FAMILY}`
  const width = ctx.measureText('W').width
  return Number.isFinite(width) && width > 0 ? width : null
}

/**
 * Waits until the board's code face is really in the document, or gives up quietly.
 *
 * Nothing is shipped for this font: Excalidraw registers all of its own faces on
 * `document.fonts` — `Fonts.loadFontFaces` walks its registry and adds every non-local one —
 * so the family resolves from the same document the overlay lives in with no `@font-face` of
 * ours anywhere. What it registers, though, is an **unloaded** `FontFace`; the browser only
 * fetches it when something asks to draw with it, and by then xterm has already measured its
 * cell against the fallback and kept the answer. Measured on a real board, all four Comic
 * Shanns faces were registered and none of them loaded.
 *
 * So this asks. Deliberately by walking the set rather than calling `document.fonts.check()`,
 * which answers about the font *list* and returns true when nothing in it matched at all —
 * a stack whose first entry does not exist is a stack that is entirely "available".
 *
 * The retry is for the ordering: the terminal block can be drawn before Excalidraw has got
 * round to registering anything, and a face that is not there yet is not a face that failed.
 * Bounded, and resolving either way — a browser that never produces it draws in the fallback,
 * which is a worse-looking terminal rather than a broken one.
 */
export function terminalFontReady(): Promise<void> {
  const wanted = TERMINAL_FONT_FACE
  const attempt = (left: number): Promise<void> => {
    let faces: FontFace[] = []
    try {
      document.fonts.forEach((face) => {
        if (face.family.replace(/^["']|["']$/g, '') === wanted) faces.push(face)
      })
    } catch {
      faces = []
    }

    if (faces.length > 0) {
      // `load()` on a face already loading returns the same promise, so asking twice is free.
      return Promise.allSettled(faces.map((face) => face.load())).then(() => undefined)
    }
    if (left <= 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(attempt(left - 1)), 250)
    })
  }
  return attempt(20)
}
