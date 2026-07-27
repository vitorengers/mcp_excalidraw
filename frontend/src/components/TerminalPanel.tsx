import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { TERMINAL_FONT_SIZE } from '../../../src/core/terminal-block'
import type { Rect } from '../../../src/core/anchored-placement'
import './TerminalPanel.css'

/** What the block says about one session, whether or not it is the tab on top. */
export interface TerminalTabState {
  id: string
  /** What the session says about itself, or null while it is still being adopted. */
  status: { cwd: string; shell: string; mode: string; cols: number; rows: number } | null
  /** The transcript, newest at the end — escape sequences and all. */
  output: string
  /** Set once the shell has gone, so the tab can say so instead of looking idle. */
  ended: string | null
}

export interface TerminalPanelProps {
  /** The block's bounds in viewport coordinates, or null when there is no block on screen. */
  rect: Rect | null
  /** The board's zoom, so the text scales with the shape it is drawn inside. */
  zoom: number
  /** True while the block is being dragged or resized, when a DOM overlay would lag it. */
  suppressed: boolean
  /** The sessions in this block, in tab order. */
  tabs: TerminalTabState[]
  activeId: string
  /** False once the board is holding the cap, so `+` says why it is not offering. */
  canAdd: boolean
  /** True when there is another terminal block for this one's tabs to be merged into. */
  canMerge: boolean
  onSelect: (sessionId: string) => void
  onAdd: () => void
  onClose: (sessionId: string) => void
  /** Take the active tab out of this block and give it a block of its own. */
  onDetach: (sessionId: string) => void
  /** Put every tab in this block into the nearest other one, and drop this block. */
  onMerge: () => void
  /** Keystrokes, as bytes: `\r` for Enter, `\x03` for Ctrl+C, `ESC [ A` for an arrow. */
  onInput: (sessionId: string, data: string) => void
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
 * One session's screen, kept alive for as long as the session is in this block.
 *
 * Its own component, and mounted for every tab rather than only the one on top, because an
 * emulator is a screen being written to rather than a log being displayed: disposing it on a
 * tab switch and rebuilding it on the way back would replay the transcript into a fresh
 * parser, which is the same picture only for a program that never used the alternate screen.
 * A `vim` left open in a background tab would come back as its own scrollback.
 *
 * Hidden with `visibility` rather than `display`, and stacked absolutely, so a screen that is
 * not on top still has real dimensions — xterm measures its cell against the DOM when it
 * opens, and one opened into a box of no size opens at the wrong size and stays there.
 */
const TerminalScreen: React.FC<{
  active: boolean
  fontSize: number
  cols: number
  rows: number
  output: string
  ended: string | null
  onData: (data: string) => void
  onFocusChange: (focused: boolean) => void
  registerFocus: (focus: (() => void) | null) => void
}> = ({ active, fontSize, cols, rows, output, ended, onData, onFocusChange, registerFocus }) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  /** How much of `output` has been handed to the emulator, so a redraw is a delta. */
  const writtenRef = useRef<string>('')
  const onDataRef = useRef(onData)
  const onFocusChangeRef = useRef(onFocusChange)
  const registerFocusRef = useRef(registerFocus)
  onDataRef.current = onData
  onFocusChangeRef.current = onFocusChange
  registerFocusRef.current = registerFocus

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

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
    terminal.onData((data) => onDataRef.current(data))
    terminalRef.current = terminal
    writtenRef.current = ''
    registerFocusRef.current(() => terminal.focus())

    const textarea = terminal.textarea
    const onFocus = (): void => onFocusChangeRef.current(true)
    const onBlur = (): void => onFocusChangeRef.current(false)
    textarea?.addEventListener('focus', onFocus)
    textarea?.addEventListener('blur', onBlur)

    return () => {
      textarea?.removeEventListener('focus', onFocus)
      textarea?.removeEventListener('blur', onBlur)
      registerFocusRef.current(null)
      terminal.dispose()
      terminalRef.current = null
      writtenRef.current = ''
    }
    // Built once for the life of this session in this block. The size and the font are
    // pushed by the effects below; rebuilding on either would lose the screen it is drawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  }, [output])

  // The grid the *shell* was told, so what it repaints to and what is drawn are one thing.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    try { terminal.resize(cols, rows) } catch { /* disposed under us */ }
  }, [cols, rows])

  // The font follows the board's zoom; the grid does not. Same screen, drawn smaller.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontSize = fontSize
  }, [fontSize])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !ended) return
    terminal.write(`\r\n[${ended}]\r\n`)
  }, [ended])

  // A screen that was hidden while it was being written to has rows the renderer never
  // painted, so coming back to a tab repaints it rather than showing whatever was on it
  // when it went away.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !active) return
    try { terminal.refresh(0, terminal.rows - 1) } catch { /* disposed under us */ }
  }, [active, cols, rows])

  return (
    <div
      className="terminal-card__screen"
      style={{ visibility: active ? 'visible' : 'hidden' }}
      ref={hostRef}
    />
  )
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
 * The body is transparent to the pointer on purpose, and that survived both the emulator and
 * the tabs. This is where a terminal in a canvas has to choose: Excalidraw owns clicking,
 * dragging and resizing the block underneath, and an overlay that took pointer events —
 * which is what xterm would like — would take the shape's own handles with it. So the pointer
 * stays with the canvas; only the strip at the bottom takes it, to hand the *keyboard* over,
 * and only the tab chips themselves, to switch, add, close, detach and merge.
 *
 * The chips are the second pointer-taking region this overlay has ever had, and they are
 * deliberately the *chips* rather than the row they sit in: a full-width strip along the top
 * of the card would sit over the block's own top edge and take the resize handles with it,
 * which is the failure this file has recorded since it was written. They are inset from the
 * card's edges for the same reason, and the browser check drags a corner afterwards to say
 * so.
 */
export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  rect, zoom, suppressed, tabs, activeId, canAdd, canMerge,
  onSelect, onAdd, onClose, onDetach, onMerge, onInput
}) => {
  /** Focus handles, one per live screen, so the prompt strip can reach the active one. */
  const focusRef = useRef<Map<string, () => void>>(new Map())
  const [attached, setAttached] = useState(false)
  /**
   * Whether the tab that is about to become active was asked for from this strip.
   *
   * Switching tab by clicking is a request to type into the other shell, so the keyboard
   * should follow — the alternative is a reader who clicks a tab, types, and finds their
   * keystrokes went to Excalidraw's tools. Gated on the click rather than run on every
   * change, because `active` also moves when a tab is closed or a block is reconciled, and
   * a block stealing the keyboard because a shell somewhere exited is worse than a click.
   */
  const followRef = useRef(false)

  const scale = Math.max(0.35, zoom)
  const fontSize = TERMINAL_FONT_SIZE * scale
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null
  const status = active?.status ?? null

  // A tab that went away cannot leave the strip claiming the keyboard is in it.
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeId)) setAttached(false)
  }, [tabs, activeId])

  // The keyboard follows a tab that was clicked. The activation is a round trip through the
  // scene — the strip is stored on the shape — so it cannot be done in the click handler.
  useEffect(() => {
    if (!followRef.current) return
    followRef.current = false
    focusRef.current.get(activeId)?.()
  }, [activeId])

  if (!rect || tabs.length === 0) return null

  /** The one gesture the canvas must not also receive. Excalidraw listens on pointerdown. */
  const takes = (handler: () => void) => (event: React.PointerEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    handler()
  }

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
        <span className="terminal-card__where" title={status?.cwd ?? ''}>{status?.cwd ?? ''}</span>
        <span className="terminal-card__grid">{status ? `${status.cols}×${status.rows}` : ''}</span>
        {/* Which of the two modes this session got. A block that says nothing about it is
            how the same feature behaves differently on two machines with no way to tell. */}
        <span
          className="terminal-card__mode"
          title={status?.mode === 'pty'
            ? 'A real terminal: full-screen programs work, and so does Ctrl+C.'
            : 'No PTY on this machine, so the shell is on pipes: one command in, its output back.'}
        >{status?.mode ?? ''}</span>
      </div>

      {/* Inset from the card's edges on purpose — see the note on the component. */}
      <div className="terminal-card__tabs">
        {tabs.map((tab) => (
          <span
            key={tab.id}
            data-session={tab.id}
            className={[
              'terminal-card__tab',
              tab.id === active?.id ? 'terminal-card__tab--active' : '',
              tab.ended ? 'terminal-card__tab--ended' : ''
            ].filter(Boolean).join(' ')}
            title={tab.ended
              ? `${tab.id} — ${tab.ended}`
              : `${tab.id}${tab.status ? ` — ${tab.status.shell}` : ''}`}
            onPointerDown={takes(() => { followRef.current = true; onSelect(tab.id) })}
          >
            <span className="terminal-card__tab-label">{tab.id}</span>
            <span
              className="terminal-card__tab-close"
              title={`close ${tab.id} and end its shell`}
              onPointerDown={takes(() => onClose(tab.id))}
            >×</span>
          </span>
        ))}

        <span
          className={`terminal-card__control terminal-card__add${canAdd ? '' : ' terminal-card__control--off'}`}
          title={canAdd
            ? 'open another shell in this block'
            : 'this board is already running as many shells as it may'}
          onPointerDown={takes(() => { if (canAdd) { followRef.current = true; onAdd() } })}
        >+</span>

        <span
          className="terminal-card__control terminal-card__detach"
          title="give this tab a block of its own — drag it wherever you like"
          onPointerDown={takes(() => { if (active) onDetach(active.id) })}
        >⧉</span>

        {canMerge && (
          <span
            className="terminal-card__control terminal-card__merge"
            title="put these tabs back into the nearest other terminal block"
            onPointerDown={takes(onMerge)}
          >⇥</span>
        )}
      </div>

      <div className="terminal-card__body">
        {tabs.map((tab) => (
          <TerminalScreen
            key={tab.id}
            active={tab.id === active?.id}
            fontSize={fontSize}
            cols={Math.max(2, tab.status?.cols ?? 80)}
            rows={Math.max(1, tab.status?.rows ?? 24)}
            output={tab.output}
            ended={tab.ended}
            onData={(data) => onInput(tab.id, data)}
            onFocusChange={(focused) => { if (tab.id === active?.id || !focused) setAttached(focused) }}
            registerFocus={(focus) => {
              if (focus) focusRef.current.set(tab.id, focus)
              else focusRef.current.delete(tab.id)
            }}
          />
        ))}
      </div>

      {/* The other part that takes the pointer. Clicking it hands the keyboard to the shell;
          clicking the canvas takes it back, which is also what leaves the block draggable
          and resizable underneath. */}
      <div
        className="terminal-card__prompt"
        onPointerDown={(event) => {
          event.stopPropagation()
          event.preventDefault()
          if (active) focusRef.current.get(active.id)?.()
        }}
        onWheel={(event) => event.stopPropagation()}
      >
        <span className="terminal-card__caret">❯</span>
        <span className="terminal-card__hint">
          {active?.ended
            ? `the shell has gone — ${active.ended}`
            : attached
              ? 'typing goes to the shell — click the canvas to give the keyboard back'
              : 'click here to type'}
        </span>
      </div>
    </div>
  )
}
