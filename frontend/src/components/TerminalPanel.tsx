import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { TERMINAL_FONT_RANGE } from '../../../src/core/terminal-block'
import type { Rect } from '../../../src/core/anchored-placement'
import './TerminalPanel.css'

export interface TerminalPanelProps {
  /** The block's bounds in viewport coordinates, or null when there is no block on screen. */
  rect: Rect | null
  /** The board's zoom, so the text scales with the shape it is drawn inside. */
  zoom: number
  /** True while the block is being dragged or resized, when a DOM overlay would lag it. */
  suppressed: boolean
  /** The transcript, newest at the end — escape sequences and all. */
  output: string
  /** What the session says about itself, or null when none is open. */
  status: { cwd: string; shell: string; mode: string; cols: number; rows: number } | null
  /** Set once the shell has gone, so the block can say so instead of looking idle. */
  ended: string | null
  /** Keystrokes, as bytes: `\r` for Enter, `\x03` for Ctrl+C, `ESC [ A` for an arrow. */
  onInput: (data: string) => void
  /** The reader's text size, before the board's zoom multiplies it. */
  fontSize: number
  /** A new one, from the buttons on the header. Clamped by whoever holds the state. */
  onFontSize: (next: number) => void
}

/**
 * A monospace stack that exists on the machines this runs on, kept in one place because
 * `terminal-block.ts` measures a cell against it and the two must not drift.
 */
const FONT_FAMILY = "'Cascadia Code', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace"

/** The block's own palette, so the emulator and the shape underneath read as one object. */
const THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#a6e3a1',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#45475a'
}

/**
 * The terminal, drawn over the block that stands for it.
 *
 * A DOM overlay rather than a scene element, for the reason the documentation card is one:
 * text on the canvas is drawn by Excalidraw, and a shell's output is neither a label nor a
 * shape. It is also what keeps the transcript out of every path that saves a board — an
 * overlay cannot be exported to PNG, synced or committed, because it was never an element.
 *
 * What is *inside* the overlay is an emulator rather than a `<pre>`, and that is #75's other
 * half. With a PTY behind the session the stream stops being text: it is cursor moves,
 * colours, an alternate screen and a program repainting itself into all three. Printed into
 * a `<pre>` that arrives as the `[33m` the screenshot in the issue showed. So the parsing
 * happens here, and the block draws a screen rather than a log.
 *
 * The difference from the documentation card is the zoom. That card is a reading column
 * pinned *next to* a shape and stays the same size on screen at any zoom. This one *is* the
 * shape: the zoom scales the font and leaves the grid alone, so a terminal zoomed out is
 * the same screen drawn smaller rather than a different number of columns.
 *
 * The **reader's** font size is a different question, and it does move the grid. `+` and
 * `-` on the header set the size the zoom multiplies, and because xterm sizes its canvas as
 * `cols` × `rows` × the font, a bigger font in the same block has to mean fewer columns and
 * fewer rows — otherwise the emulator draws past the frame and the overshoot is clipped
 * rather than scrolled. So a step recomputes the grid from the block's scene size at the
 * new font and reports it down the route a corner drag already uses; what comes back is
 * what the header shows.
 *
 * The body is transparent to the pointer on purpose, and that survived the emulator. This
 * is where a terminal in a canvas has to choose: Excalidraw owns clicking, dragging and
 * resizing the block underneath, and an overlay that took pointer events — which is what
 * xterm would like — would take the shape's own handles with it. So the pointer stays with
 * the canvas, and the two places that take it back say what they are for: the strip at the
 * bottom hands the *keyboard* over, and the two buttons on the header set the size. Once
 * the strip has been clicked every keystroke goes to the shell, Ctrl+C included; clicking
 * anywhere on the canvas blurs it and gives the keyboard back. The cost is the one the
 * transcript already had: no selecting or scrolling with the mouse.
 */
export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  rect, zoom, suppressed, output, status, ended, onInput, fontSize: readerFontSize, onFontSize
}) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  /** How much of `output` has been handed to the emulator, so a redraw is a delta. */
  const writtenRef = useRef<string>('')
  const onInputRef = useRef(onInput)
  onInputRef.current = onInput

  const [attached, setAttached] = useState(false)

  const drawn = Boolean(rect && status)
  const scale = Math.max(0.35, zoom)
  // The reader's size is the base and the board's zoom multiplies it, so the two answer
  // different questions: the zoom is how close the board is, and this is how big the text
  // is on it. Only the first of them is allowed to leave the grid alone.
  const fontSize = readerFontSize * scale
  const cols = Math.max(2, status?.cols ?? 80)
  const rows = Math.max(1, status?.rows ?? 24)

  // Built when there is a block to build it in, and taken apart when there is not. The
  // transcript survives either way: it lives in `output` above this component, so a block
  // deleted and brought back replays rather than starts empty.
  useEffect(() => {
    const host = hostRef.current
    if (!drawn || !host) return

    const terminal = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize,
      // The same 1.35 the block's cell metric is derived from, so `cols`×`rows` fills it.
      lineHeight: 1.35,
      cols,
      rows,
      cursorBlink: true,
      theme: THEME
    })
    terminal.open(host)
    terminal.onData((data) => onInputRef.current(data))
    terminalRef.current = terminal
    writtenRef.current = ''

    const textarea = terminal.textarea
    const onFocus = (): void => setAttached(true)
    const onBlur = (): void => setAttached(false)
    textarea?.addEventListener('focus', onFocus)
    textarea?.addEventListener('blur', onBlur)

    return () => {
      textarea?.removeEventListener('focus', onFocus)
      textarea?.removeEventListener('blur', onBlur)
      terminal.dispose()
      terminalRef.current = null
      writtenRef.current = ''
      setAttached(false)
    }
    // Deliberately only `drawn`: the size and the font are pushed by the effects below,
    // and rebuilding the emulator on every zoom would lose the screen it is drawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn])

  // The delta, not the whole thing: an emulator is a screen being written to, so handing it
  // the transcript again on every chunk would print the session over itself. A transcript
  // that no longer starts with what has been written is a different session — a reload, or
  // a shell that was replaced — and that is the one case worth a reset.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    const written = writtenRef.current
    if (output === written) return
    if (output.startsWith(written)) terminal.write(output.slice(written.length))
    else { terminal.reset(); terminal.write(output) }
    writtenRef.current = output
  }, [output, drawn])

  // The grid the *shell* was told, so what it repaints to and what is drawn are one thing.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    try { terminal.resize(cols, rows) } catch { /* disposed under us */ }
  }, [cols, rows, drawn])

  // The font follows the board's zoom; the grid does not. Same screen, drawn smaller.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontSize = fontSize
  }, [fontSize, drawn])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !ended) return
    terminal.write(`\r\n[${ended}]\r\n`)
  }, [ended, drawn])

  const atFloor = readerFontSize <= TERMINAL_FONT_RANGE.min
  const atCeiling = readerFontSize >= TERMINAL_FONT_RANGE.max

  /**
   * A step, taken on `pointerdown` rather than on `click`.
   *
   * The same event the prompt strip acts on, and for the same reason: this overlay stops
   * pointer events so that what it does not stop reaches the canvas, and a handler that
   * waited for the synthesised click would be reasoning about a second event that the
   * first one's `preventDefault` is entitled to suppress.
   *
   * At either end of the range the step is a no-op rather than a dead button: the click is
   * still swallowed here, so `+` at the top does not fall through and select the block.
   */
  const stepBy = (delta: number) => (event: React.PointerEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    onFontSize(readerFontSize + delta)
  }

  if (!rect || !status) return null

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
      // Every key the emulator has taken stops here. Excalidraw binds bare letters to tools
      // and listens below this container, so a keystroke that got past would change the
      // active tool instead of reaching the shell.
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div className="terminal-card__header">
        <span className="terminal-card__where" title={status.cwd}>{status.cwd}</span>
        <span className="terminal-card__grid">{status.cols}×{status.rows}</span>

        {/* The reader's own size, and the second thing on this overlay that takes a click.
            Buttons rather than a shortcut because while the terminal has the keyboard every
            keystroke belongs to the shell — Ctrl+- would reach the shell, not the block.
            They are as small as a target can be and still be one: every pixel that takes
            the pointer is a pixel that no longer selects or drags the shape underneath.
            The grid beside them is the confirmation, since it is what the shell was told. */}
        <span className="terminal-card__font">
          <button
            type="button"
            className={`terminal-card__font-step${atFloor ? ' terminal-card__font-step--spent' : ''}`}
            title="Smaller text — the same block, so more columns and rows"
            aria-label="Smaller terminal text"
            onPointerDown={stepBy(-TERMINAL_FONT_RANGE.step)}
          >−</button>
          <span
            className="terminal-card__font-size"
            title={`The terminal's text, ${TERMINAL_FONT_RANGE.min}–${TERMINAL_FONT_RANGE.max}. The board's zoom still multiplies it.`}
          >{readerFontSize}</span>
          <button
            type="button"
            className={`terminal-card__font-step${atCeiling ? ' terminal-card__font-step--spent' : ''}`}
            title="Bigger text — the same block, so fewer columns and rows"
            aria-label="Bigger terminal text"
            onPointerDown={stepBy(TERMINAL_FONT_RANGE.step)}
          >+</button>
        </span>

        {/* Which of the two modes this session got. A block that says nothing about it is
            how the same feature behaves differently on two machines with no way to tell. */}
        <span
          className="terminal-card__mode"
          title={status.mode === 'pty'
            ? 'A real terminal: full-screen programs work, and so does Ctrl+C.'
            : 'No PTY on this machine, so the shell is on pipes: one command in, its output back.'}
        >{status.mode}</span>
      </div>

      <div className="terminal-card__body" ref={hostRef} />

      {/* The one part that takes the pointer, and the only reason this overlay stops events
          at all. Clicking it hands the keyboard to the shell; clicking the canvas takes it
          back, which is also what leaves the block draggable and resizable underneath. */}
      <div
        className="terminal-card__prompt"
        onPointerDown={(event) => {
          event.stopPropagation()
          event.preventDefault()
          terminalRef.current?.focus()
        }}
        onWheel={(event) => event.stopPropagation()}
      >
        <span className="terminal-card__caret">❯</span>
        <span className="terminal-card__hint">
          {ended
            ? `the shell has gone — ${ended}`
            : attached
              ? 'typing goes to the shell — click the canvas to give the keyboard back'
              : 'click here to type'}
        </span>
      </div>
    </div>
  )
}
