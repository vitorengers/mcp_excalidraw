import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
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
  /** The transcript, newest at the end — escape sequences and all. */
  output: string
  /** What the session says about itself, or null when none is open. */
  status: { cwd: string; shell: string; mode: string; cols: number; rows: number } | null
  /** Set once the shell has gone, so the block can say so instead of looking idle. */
  ended: string | null
  /** Keystrokes, as bytes: `\r` for Enter, `\x03` for Ctrl+C, `ESC [ A` for an arrow. */
  onInput: (data: string) => void
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
 * shape: the grid is fixed by the block's scene size — the same `cols`×`rows` the shell was
 * told — and the font scales with the board, so a terminal zoomed out is the same screen
 * drawn smaller rather than a different number of columns.
 *
 * The body is transparent to the pointer on purpose, and that survived the emulator. This
 * is where a terminal in a canvas has to choose: Excalidraw owns clicking, dragging and
 * resizing the block underneath, and an overlay that took pointer events — which is what
 * xterm would like — would take the shape's own handles with it. So the pointer stays with
 * the canvas and only the strip at the bottom takes it, to hand the *keyboard* over. Once
 * it has been clicked every keystroke goes to the shell, Ctrl+C included; clicking anywhere
 * on the canvas blurs it and gives the keyboard back. The cost is the one the transcript
 * already had: no selecting or scrolling with the mouse.
 */
export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  rect, zoom, suppressed, output, status, ended, onInput
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
  const fontSize = TERMINAL_FONT_SIZE * scale
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
