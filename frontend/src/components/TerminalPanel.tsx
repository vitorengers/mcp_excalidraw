import React, { useEffect, useRef } from 'react'
import { TERMINAL_FONT_SIZE } from '../../../src/core/terminal-block'
import type { Rect } from '../../../src/core/anchored-placement'
import './TerminalPanel.css'

export interface TerminalPanelProps {
  /** The block's bounds in viewport coordinates, or null when there is no block on screen. */
  rect: Rect | null
  /** The board's zoom, so the text scales with the shape it is drawn inside. */
  zoom: number
  /** True while the block is being dragged or resized, when a DOM overlay would lag it. */
  suppressed: boolean
  /** The transcript, newest at the end. */
  output: string
  /** What the session says about itself, or null when none is open. */
  status: { cwd: string; shell: string; cols: number; rows: number } | null
  /** Set once the shell has gone, so the block can say so instead of looking idle. */
  ended: string | null
  onSubmit: (line: string) => void
}

/**
 * The terminal, drawn over the block that stands for it.
 *
 * A DOM overlay rather than a scene element, for the reason the documentation card is one:
 * text on the canvas is drawn by Excalidraw, and a shell's output is neither a label nor a
 * shape. It is also what keeps the transcript out of every path that saves a board — an
 * overlay cannot be exported to PNG, synced or committed, because it was never an element.
 *
 * The difference from the documentation card is the zoom. That card is a reading column
 * pinned *next to* a shape and stays the same size on screen at any zoom. This one *is* the
 * shape: it fills the block's own bounds and its font scales with the board, so a terminal
 * zoomed out reads as a small dark box rather than as a giant font in a tiny frame. Alt+T
 * is what brings it back to a size you can read.
 *
 * The body is transparent to the pointer on purpose. Excalidraw owns clicking, dragging and
 * resizing the block underneath — that is what "resizing on the board" means, and an
 * overlay that swallowed pointer events would take the shape's own handles away with it.
 * The cost is that the transcript cannot be scrolled or selected with the mouse yet: it is
 * pinned to the bottom, and a taller block shows more. Only the input row takes the pointer.
 */
export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  rect, zoom, suppressed, output, status, ended, onSubmit
}) => {
  const bodyRef = useRef<HTMLPreElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Pinned to the newest line. A terminal that shows the top of a transcript while
  // something is still writing to the bottom of it is showing the wrong end.
  useEffect(() => {
    const body = bodyRef.current
    if (body) body.scrollTop = body.scrollHeight
  }, [output, rect?.height])

  if (!rect || !status) return null

  const scale = Math.max(0.35, zoom)
  const fontSize = TERMINAL_FONT_SIZE * scale

  return (
    <div
      className="terminal-card"
      style={{
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        fontSize: `${fontSize}px`,
        visibility: suppressed ? 'hidden' : 'visible'
      }}
    >
      <div className="terminal-card__header">
        <span className="terminal-card__where" title={status.cwd}>{status.cwd}</span>
        <span className="terminal-card__grid">{status.cols}×{status.rows}</span>
      </div>

      <pre className="terminal-card__body" ref={bodyRef}>{output}
        {ended ? `\n[${ended}]\n` : ''}</pre>

      {/* The one part that takes the pointer, and the only reason this overlay needs to
          stop events at all: Excalidraw binds every bare letter to a tool, so a keystroke
          that reached the canvas would change the active tool instead of typing a command. */}
      <form
        className="terminal-card__prompt"
        onSubmit={(event) => {
          event.preventDefault()
          const input = inputRef.current
          if (!input) return
          onSubmit(input.value)
          input.value = ''
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <span className="terminal-card__caret">❯</span>
        <input
          ref={inputRef}
          className="terminal-card__input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          disabled={Boolean(ended)}
          placeholder={ended ? 'the shell has gone' : 'a command, then Enter'}
          style={{ fontSize: `${fontSize}px` }}
        />
      </form>
    </div>
  )
}
