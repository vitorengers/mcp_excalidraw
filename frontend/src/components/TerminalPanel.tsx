import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  TERMINAL_FALLBACK_FONT_FAMILY,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_RANGE,
  TERMINAL_LINE_HEIGHT
} from '../../../src/core/terminal-block'
import { terminalCssVars, terminalXtermTheme } from '../../../src/core/terminal-palette'
import type { TerminalTheme } from '../../../src/core/terminal-palette'
import { terminalFontReady } from '../terminal-metrics'
import type { Rect } from '../../../src/core/anchored-placement'
import './TerminalPanel.css'

/** What the block says about one session, whether or not it is the tab on top. */
export interface TerminalTabState {
  id: string
  /** What the session says about itself, or null while it is still being adopted. */
  status: {
    cwd: string
    shell: string
    mode: string
    cols: number
    rows: number
    /**
     * Whose session this is, when the board opened it for one of its own agents.
     *
     * Null for every shell a reader started, which is the ordinary case and the one that
     * keeps its `s1`. A run's tab appears without anyone clicking for it, so it has to say
     * what it is: `s4` beside three shells the reader opened names nothing they did.
     */
    owner: { agent: string; issueUrl: string; label: string } | null
  } | null
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
  /** The reader's text size, before the board's zoom multiplies it. */
  fontSize: number
  /** A new one, from the buttons on the header. Clamped by whoever holds the state. */
  onFontSize: (next: number) => void
  /**
   * Which theme the canvas is in, which this overlay has to be told.
   *
   * Excalidraw draws dark mode as a filter on its own canvas, and this card is a sibling of
   * it rather than a child, so nothing filters it: told nothing, it paints a light card on a
   * dark board over a block the filter has already darkened. See `terminal-palette.ts`.
   */
  theme: TerminalTheme
}

/**
 * The board's own canvas, told a wheel it was never on the path of.
 *
 * Re-dispatched rather than left to bubble: this overlay is a *sibling* of the canvas, not
 * a child, so Excalidraw's listener is nowhere on this event's path. And it goes to the
 * **canvas** rather than to the container that listens, because that listener drops any
 * wheel whose target is not a canvas, a textarea or an iframe — a board that scrolled while
 * the pointer was over a menu is the bug it is guarding against.
 */
function dispatchWheelToCanvas(event: React.WheelEvent, deltaX: number, deltaY: number): void {
  const canvas = document.querySelector('.excalidraw__canvas.interactive')
    ?? document.querySelector('.excalidraw__canvas')
  if (!canvas) return
  canvas.dispatchEvent(new WheelEvent('wheel', {
    deltaX,
    deltaY,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    bubbles: true,
    cancelable: true
  }))
}

/**
 * The sideways half of a wheel, which is the board's whatever the emulator is doing.
 *
 * Nothing under this overlay has a use for it. xterm has no horizontal scrolling —
 * `_getPixelsScrolled` reads `deltaY` and never `deltaX` — and it emits no escape sequence
 * for one either: a mouse report takes its button from the sign of `deltaY`, so a wheel
 * that only went sideways is cancelled and reported as nothing at all. So this axis is
 * answered without asking either of the questions below.
 *
 * **In the capture phase, and that is the whole reason it is a second handler.** A program
 * holding the pointer has xterm cancelling the wheel with `stopPropagation` as well as
 * `preventDefault`, and React listens at the root: an event stopped at the `.xterm` element
 * never reaches the bubbling handler at all, so a guard there is a guard that never runs.
 * The capture pass goes root-first and has already happened by then.
 */
function forwardHorizontalWheelToCanvas(event: React.WheelEvent): void {
  // The three the board reads as one gesture rather than as a pan; see below.
  if (event.ctrlKey || event.metaKey || event.shiftKey) return
  if (event.deltaX === 0) return
  dispatchWheelToCanvas(event, event.deltaX, 0)
}

/**
 * A wheel the emulator did not want, given to the board instead of dropped.
 *
 * The block is a shape on a board, and over any other shape that wheel pans or zooms. Now
 * that the overlay takes the pointer it also takes the wheel, so without this a terminal
 * would be a hole in the board's own navigation — the failure #112 names as worse than
 * either answer to the question of who owns the wheel.
 *
 * Two ways the emulator says it has spoken for one. It calls `preventDefault` on the wheel
 * it scrolled the scrollback with, and leaves the one it could not use alone — the screen is
 * already at the bottom, or there is no scrollback at all. And a program that has turned
 * mouse reporting on is being sent the wheel as an escape sequence, which xterm marks with a
 * class on its own root rather than with the event.
 *
 * What is left is handed to `dispatchWheelToCanvas` above rather than left to bubble.
 *
 * **Both of those ways of saying it are answers about the event, and a touchpad pan is two
 * axes at once.** That is #162: the reader pans diagonally over a block, the scrollback has
 * room, xterm scrolls four pixels of it and calls `preventDefault` — and the hundred and
 * twenty pixels of sideways pan in the same event go with it. So the question is put per
 * axis, by `forwardHorizontalWheelToCanvas` above and by this one below it. What is left
 * here is the vertical half, asked exactly what the whole event used to be asked, and it
 * carries no `deltaX` because the other half has already been answered.
 *
 * Ctrl, Meta and Shift are left whole, and this is where whole still means whole. Those
 * three are not a pan: the first two are the zoom gesture and Shift is Excalidraw's own
 * sideways wheel, and all three read the axes together — `deltaY || deltaX` for Shift, the
 * sign of `deltaY` for the zoom — so splitting one would be two gestures where the reader
 * made one.
 */
function forwardWheelToCanvas(event: React.WheelEvent): void {
  if (event.nativeEvent.defaultPrevented) return
  if ((event.target as Element | null)?.closest?.('.xterm.enable-mouse-events')) return
  const whole = event.ctrlKey || event.metaKey || event.shiftKey
  if (!whole && event.deltaY === 0) return
  dispatchWheelToCanvas(event, whole ? event.deltaX : 0, event.deltaY)
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
  theme: TerminalTheme
  onData: (data: string) => void
  registerFocus: (focus: (() => void) | null) => void
}> = ({ active, fontSize, cols, rows, output, ended, theme, onData, registerFocus }) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  /** How much of `output` has been handed to the emulator, so a redraw is a delta. */
  const writtenRef = useRef<string>('')
  const onDataRef = useRef(onData)
  const registerFocusRef = useRef(registerFocus)
  onDataRef.current = onData
  registerFocusRef.current = registerFocus

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const terminal = new Terminal({
      // Both from `terminal-block.ts`, and not because they are constants. The grid is
      // derived from this font's measured line box times this multiplier, so an emulator
      // opened with either of its own would be drawing a row the block never divided by.
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize,
      lineHeight: TERMINAL_LINE_HEIGHT,
      cols,
      rows,
      cursorBlink: true,
      // The theme this block is *opened* in. It is pushed again below whenever the board's
      // changes — this effect must not depend on it, or a toggle would rebuild the emulator.
      theme: terminalXtermTheme(theme)
    })
    terminal.open(host)
    terminal.onData((data) => onDataRef.current(data))

    // The two keystrokes a browser and a shell both claim, settled the way this machine's own
    // terminal settles them. Everything else is the shell's, which is the whole point of the
    // block taking the keyboard.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      // AltGr arrives as Ctrl+Alt on several layouts, and it is somebody typing a `@`.
      if (event.altKey || !(event.ctrlKey || event.metaKey)) return true
      const key = event.key.toLowerCase()

      // Ctrl+C is a copy while something is selected and an interrupt the rest of the time.
      // The selection is dropped straight after, so the second press is an interrupt again —
      // without that, a reader who had selected something would have no way to stop a shell
      // that was running away.
      if (key === 'c' && terminal.hasSelection()) {
        const selected = terminal.getSelection()
        event.preventDefault()
        terminal.clearSelection()
        void navigator.clipboard?.writeText(selected).catch(() => { /* no clipboard here */ })
        return false
      }

      // Ctrl+V is the browser's, not the shell's: xterm already listens for the `paste` event
      // the default action fires, and handing this to the shell instead would send it the
      // `\x16` that Ctrl+V means on a terminal. Returning false is what leaves the default
      // alone — xterm's own key handling would have cancelled the event.
      if (key === 'v') return false

      return true
    })

    terminalRef.current = terminal
    writtenRef.current = ''
    registerFocusRef.current(() => terminal.focus())

    // The face the block is drawn in is a web font, and `open()` above is where xterm
    // measures its cell — so on the first screen of a session it is measuring the *fallback*
    // and keeping that answer for good. Opening later instead would mean an emulator that
    // does not exist while the transcript is arriving, so the measurement is redone rather
    // than delayed.
    //
    // Asking for it takes naming the fallback and then naming the real stack again: xterm's
    // options service fires only on a value that changed, so setting `fontFamily` to what it
    // already is does nothing at all. The pair is one turn of `clear` and `handleResize`,
    // which is what re-measures. Two writes rather than one comment saying "does not work".
    let settled = false
    void terminalFontReady().then(() => {
      if (settled || terminalRef.current !== terminal) return
      terminal.options.fontFamily = TERMINAL_FALLBACK_FONT_FAMILY
      terminal.options.fontFamily = TERMINAL_FONT_FAMILY
    })

    return () => {
      settled = true
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

  // The board's theme, re-themed into the emulator that is already running rather than into
  // a new one. Rebuilding it on a toggle would replay the transcript into a fresh parser,
  // which is the same picture only for a program that never used the alternate screen — the
  // `vim` left open in this tab would come back as its own scrollback. xterm repaints from
  // the object it is handed, so a whole palette goes in at once and none of it is half a set.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.theme = terminalXtermTheme(theme)
  }, [theme])

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
 * **The screen takes the pointer and the header does not**, which is #112 and the reverse of
 * what this file said for its first three revisions. The old arrangement made the whole
 * overlay transparent and carved one strip out of the bottom that said `click here to type`,
 * on the reasoning that an overlay taking pointer events would take the shape's resize
 * handles with it. That reasoning was measured and found wrong: Excalidraw's handles sit two
 * to ten screen pixels *outside* an element's bounds and the overlay covers exactly the
 * bounds, so the screen can take every click it likes and the block keeps every handle.
 *
 * What a pointer-taking screen really costs is selecting and dragging the block from its
 * middle, and that is what the header buys back. Clicking the header selects the shape,
 * dragging it moves the shape, and the handles that appear are the shape's own — so the
 * header is load bearing for resizing too, since a handle only exists while something is
 * selected. Below it the pointer is the shell's: a click focuses the emulator, a drag selects
 * text, the wheel scrolls the scrollback, and Alt+click moves the shell's own cursor along
 * the line it is editing. A wheel the scrollback has no use for is handed back to the canvas
 * rather than swallowed — see `forwardWheelToCanvas`.
 *
 * The tab chips stay the *chips* rather than the row they sit in, and the font buttons stay
 * as small as a target can be, for the reason that survived: the top of the card is now the
 * whole of what selects and drags the block, so every pixel of it that takes the pointer is
 * a pixel that no longer grabs the shape. The browser checks drag a corner afterwards to say
 * the shape is still a shape.
 *
 * What #144 changed about that is the *size* of a chip rather than which part of the row
 * takes the pointer: the strip is drawn at `--terminal-tab-scale`, half again as big, while
 * the row around the chips stays transparent and the header above them stays exactly the
 * size it was. The budget #112 was defending is the header band, and the strip is not it.
 * The same change took the bar off the bottom of the block — two of its three sentences
 * described where the pointer already was, and the one that did not is now drawn over the
 * screen, which is where the reader is looking when a shell has gone.
 */
export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  rect, zoom, suppressed, tabs, activeId, canAdd, canMerge,
  onSelect, onAdd, onClose, onDetach, onMerge, onInput,
  fontSize: readerFontSize, onFontSize, theme
}) => {
  /** Focus handles, one per live screen, so a click anywhere can reach the active one. */
  const focusRef = useRef<Map<string, () => void>>(new Map())
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
  // The reader's size is the base and the board's zoom multiplies it, so the two answer
  // different questions: the zoom is how close the board is, and this is how big the text
  // is on it. Only the first of them is allowed to leave the grid alone.
  const fontSize = readerFontSize * scale
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null
  const status = active?.status ?? null

  // The keyboard follows a tab that was clicked. The activation is a round trip through the
  // scene — the strip is stored on the shape — so it cannot be done in the click handler.
  useEffect(() => {
    if (!followRef.current) return
    followRef.current = false
    focusRef.current.get(activeId)?.()
  }, [activeId])

  if (!rect || tabs.length === 0) return null

  /**
   * The one gesture the canvas must not also receive.
   *
   * `pointerdown` rather than `click`, and for the reason the screen below gives: this
   * overlay stops pointer events so that what it does not stop reaches the canvas, and a
   * handler waiting for the synthesised click would be reasoning about a second event that
   * the first one's `preventDefault` is entitled to suppress.
   */
  const takes = (handler: () => void) => (event: React.PointerEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    handler()
  }

  const atFloor = readerFontSize <= TERMINAL_FONT_RANGE.min
  const atCeiling = readerFontSize >= TERMINAL_FONT_RANGE.max
  // At either end of the range the step is a no-op rather than a dead button: the click is
  // still swallowed, so `+` at the top does not fall through and select the block.
  const stepBy = (delta: number) => takes(() => onFontSize(readerFontSize + delta))

  return (
    <div
      className="terminal-card"
      style={{
        // The palette, on this card rather than on `:root`: a board with two terminal blocks
        // is two independent surfaces, and nothing about them should reach the canvas around
        // them. `TerminalPanel.css` reads these and holds no colour of its own.
        //
        // The whole set is swapped here rather than by a `[data-theme]` rule, and #121's trap
        // is both reasons: these are inline styles, which a rule cannot outrank, and a theme
        // that landed on part of a palette would be worse than one that landed on none of it.
        ...(terminalCssVars(theme) as React.CSSProperties),
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

        {/* The reader's own size, and one of the three things on this overlay that take a
            click.
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
              : `${tab.id}${tab.status?.owner ? ` — implementing ${tab.status.owner.issueUrl}` : ''}`
                + `${tab.status ? ` — ${tab.status.shell}` : ''}`}
            onPointerDown={takes(() => { followRef.current = true; onSelect(tab.id) })}
          >
            {/* An owned tab says what it is running; a reader's shell keeps its `s1`. The
                id has not gone anywhere — it is the first thing in the tooltip, and it is
                still what `data-session` and every route are keyed on. */}
            <span className="terminal-card__tab-label">{tab.status?.owner?.label || tab.id}</span>
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

      {/* The screen, and the part of the overlay the pointer belongs to. The focus is taken
          on pointer *down* rather than on click, matching what the strip below has always
          done: a click is a second event, and the drag that selects text never produces one.
          Nothing is prevented here — xterm's own selection and cursor handling has already
          run by the time this fires, and preventing the default would undo it. */}
      <div
        className="terminal-card__body"
        onPointerDown={(event) => {
          event.stopPropagation()
          if (active) focusRef.current.get(active.id)?.()
        }}
        onWheelCapture={forwardHorizontalWheelToCanvas}
        onWheel={forwardWheelToCanvas}
      >
        {tabs.map((tab) => (
          <TerminalScreen
            key={tab.id}
            active={tab.id === active?.id}
            fontSize={fontSize}
            cols={Math.max(2, tab.status?.cols ?? 80)}
            rows={Math.max(1, tab.status?.rows ?? 24)}
            output={tab.output}
            ended={tab.ended}
            theme={theme}
            onData={(data) => onInput(tab.id, data)}
            registerFocus={(focus) => {
              if (focus) focusRef.current.set(tab.id, focus)
              else focusRef.current.delete(tab.id)
            }}
          />
        ))}

        {/* The way back from a shell that has gone, and all that is left of the bar that used
            to run along the bottom of the block. Alt+T was written down only in markdown,
            which is the half of #93 that was never about the eraser; with tabs there is a
            nearer way out — `+` opens another shell beside this one — so it names both.

            Last in the frame rather than below it. Below it was a row, and a row is chrome:
            `terminalChrome()` is what the grid is derived from, so a band that appeared when
            a shell exited would re-grid the block at the moment its shell died. Here it is
            drawn over the transcript, which is what the reader is already looking at, and
            after the screens so it is not painted under one. It takes no pointer events at
            all — a notice is not a control, and the click underneath it still belongs to the
            screen. */}
        {active?.ended && (
          <div className="terminal-card__ended">
            the shell has gone — {active.ended} — press + for another, or Alt+T
          </div>
        )}
      </div>
    </div>
  )
}
