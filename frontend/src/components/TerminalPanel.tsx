import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { hasFoldMarks, parseFoldedTranscript } from '../../../src/core/agent-stream-render'
import type { FoldDetail, FoldRow, FoldSegment } from '../../../src/core/agent-stream-render'
import {
  TERMINAL_FALLBACK_FONT_FAMILY,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_RANGE,
  TERMINAL_LINE_HEIGHT,
  terminalScrollbar
} from '../../../src/core/terminal-block'
import { terminalCssVars, terminalDocumentInk, terminalXtermTheme } from '../../../src/core/terminal-palette'
import type { TerminalTheme } from '../../../src/core/terminal-palette'
import { clipboardImages } from '../../../src/core/pasted-images'
import { terminalFontReady } from '../terminal-metrics'
import { macKeyboard, terminalEditingChord } from '../terminal-keys'
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
    /** Whether the session has stdin left for a keystroke to reach. See `App.tsx`. */
    readOnly?: boolean
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
  /**
   * The four keys the board navigates by, answered on the press by whoever owns the scene.
   *
   * This block sees a keystroke before anything on `window` does — xterm reads the keyboard
   * through its own hidden textarea inside this card — so the board cannot take these back
   * after the fact. It has to be asked here, before the emulator writes the meta escape and
   * before the card stops the event propagating. See `board-hotkeys.ts` for all three layers.
   */
  isBoardHotkey: (event: KeyboardEvent) => boolean
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
 * How much sideways a gesture has to carry, against its vertical, to be going sideways.
 *
 * A ratio rather than a dominance test, and that is not a detail: `|deltaX| > |deltaY|`
 * would refuse an exactly 45° pan, which is a diagonal the reader plainly meant and which
 * `scripts/check-terminal-focus-browser.mjs` asserts does both. The two populations are an
 * order of magnitude apart — a hand's tremor is around `3/120`, a deliberate diagonal is
 * `1.0` — so anything in roughly 0.2 to 0.5 separates them, and nothing narrower is
 * derivable from synthetic events. This end of the bracket is the forgiving one: it lets a
 * shallow but deliberate diagonal through and only refuses what is unambiguously noise.
 */
const SIDEWAYS_INTENT_RATIO = 0.25

/**
 * How long the wheel has to stop for before the next one is a new gesture.
 *
 * The DOM gives no help here: `wheel` is discrete and has no `wheelend` to pair with it the
 * way `pointerdown` has `pointerup`, so the end of a gesture can only be inferred from a
 * gap. A trackpad pans at 60-120 Hz, so any gap this long is the finger off the glass, and
 * it is short enough that lifting off and panning sideways works immediately.
 */
const WHEEL_GESTURE_IDLE_MS = 180

/**
 * Below this, an event says nothing about which way the gesture is going.
 *
 * Deciding the axis from the first event that arrives would let a half-pixel of jitter at
 * the very start of a pan name the whole gesture. The floor is in whatever unit the event
 * is in — a `deltaMode` of lines makes 1 a whole notch, which is real movement either way.
 */
const WHEEL_MEANINGFUL_DELTA = 1

/**
 * What this gesture was decided to be, and when it was last seen.
 *
 * Module-level rather than per block, because there is one pointer and therefore one
 * gesture: a pan that crosses from one terminal block onto another is still the same finger
 * still going the same way, and two locks would let it change its mind halfway across.
 *
 * `'undecided'` until an event carries enough movement to say. `'free'` is the state every
 * gesture had before #198 — both axes answered on their own merits.
 */
let wheelGestureAxis: 'undecided' | 'vertical' | 'free' = 'undecided'
let wheelGestureSeenAt = 0

/**
 * Which axis this gesture is on, decided once and then held.
 *
 * The reason the decision is gesture-scoped rather than taken per event is the middle of a
 * pan: a finger pausing on its way up still drifts sideways, and the event it produces then
 * has real `deltaX` and no `deltaY` at all. Read on its own that is a sideways pan. Read as
 * part of the gesture it is the same drift as every event around it — which is a property
 * of the span, and a handler that only ever sees one event cannot have an opinion about it.
 */
function wheelGestureAxisFor(event: React.WheelEvent): 'undecided' | 'vertical' | 'free' {
  const now = performance.now()
  const continues = now - wheelGestureSeenAt < WHEEL_GESTURE_IDLE_MS
  wheelGestureSeenAt = now
  if (!continues) wheelGestureAxis = 'undecided'
  if (wheelGestureAxis === 'undecided') {
    const across = Math.abs(event.deltaX)
    const along = Math.abs(event.deltaY)
    if (across >= WHEEL_MEANINGFUL_DELTA || along >= WHEEL_MEANINGFUL_DELTA) {
      wheelGestureAxis = across >= along * SIDEWAYS_INTENT_RATIO ? 'free' : 'vertical'
    }
  }
  return wheelGestureAxis
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
 *
 * **But not every sideways pixel is a sideways pan**, and that is #198. #162 was written
 * against a mouse wheel and a deliberate diagonal, where every `deltaX` is one the reader
 * meant; a finger on a trackpad is never exactly vertical, so scrolling a scrollback emits
 * a few pixels of `deltaX` per event whose sign follows the tremor of the hand. Answered
 * one at a time, at 60-120 Hz, that is a board swinging left and right for as long as the
 * reader keeps reading. So the axis is decided for the gesture above and held, and a
 * gesture that went up drops its sideways half rather than forwarding it.
 *
 * The lock is deliberately **not symmetric** — see `docs/terminal.md`.
 */
function forwardHorizontalWheelToCanvas(event: React.WheelEvent): void {
  // The three the board reads as one gesture rather than as a pan; see below. Left before
  // the lock as well as outside it: those gestures are not pans, so the clock they would
  // stamp is not theirs, and the pan on either side of one is its own gesture anyway.
  if (event.ctrlKey || event.metaKey || event.shiftKey) return
  if (wheelGestureAxisFor(event) === 'vertical') return
  if (event.deltaX === 0) return
  dispatchWheelToCanvas(event, event.deltaX, 0)
}

/**
 * How much taller than its own box a scroller has to be to count as having scrollback.
 *
 * Not zero, and not a tolerance for bad measurement either: the two numbers are derived
 * from one measured cell height by two different roundings. xterm sizes its scroll area to
 * `Math.round(rowHeight * lines)` and its viewport from the renderer's canvas, so a screen
 * holding exactly its own rows and nothing behind them can still come out a fraction of a
 * pixel taller than the box it sits in. A row is ten pixels at the smallest font this block
 * offers, so two pixels cannot hide one.
 */
const SCROLLBACK_SLACK_PX = 2

/**
 * Whether the view under the pointer has anything of its own to scroll.
 *
 * Asked of the box rather than of the event, and that is #256. `defaultPrevented` answers
 * "did *this* wheel move anything", which cannot tell a reader who has run out of scrollback
 * halfway through reading from a reader who wants to pan the board — and the first of those
 * had the canvas slide out from under the block they were reading.
 *
 * One question for both views, because the two draw the same box: an emulator's `.xterm-viewport`
 * is what scrolls inside `.terminal-card__screen`, and a rendered transcript borrows that class
 * and scrolls itself. A pointer over neither — the body's own margin, a card with no session —
 * finds nothing and the board answers, which is what it always did.
 *
 * Re-asked per event rather than latched for the gesture, and it comes to the same thing: a
 * scrollback does not appear or vanish between two notches of one wheel. What the gesture lock
 * above exists for is the *axis*, which a single event genuinely cannot settle.
 */
function terminalHasScrollToGive(target: EventTarget | null): boolean {
  const screen = (target as Element | null)?.closest?.('.terminal-card__screen')
  if (!screen) return false
  const scroller = screen.querySelector('.xterm-viewport') ?? screen
  return scroller.scrollHeight > scroller.clientHeight + SCROLLBACK_SLACK_PX
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
 * it scrolled the scrollback with, and leaves the one it could not use alone. And a program
 * that has turned mouse reporting on is being sent the wheel as an escape sequence, which
 * xterm marks with a class on its own root rather than with the event.
 *
 * **But "it could not use this one" was two situations read as one**, and that is #256. xterm
 * declines to prevent a wheel at either end of its viewport — `_bubbleScroll` prevents only
 * while there is room in the wheel's direction — so a reader who scrolled to the top of sixty
 * lines and kept going had the next notch pan the board out from under the block. That is not
 * the same as a block with no scrollback at all, which is the case #112 answered and which
 * still hands the wheel over. So the question below is asked of the box: **while the terminal
 * has something to scroll the vertical wheel is the terminal's**, at its ends as much as in
 * its middle, and a reader who wants to pan has the header and the rest of the canvas.
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
  // Not asked of the three above: Ctrl and Meta are the zoom and Shift is Excalidraw's own
  // sideways wheel, and none of them is a request to scroll the scrollback — a block with a
  // deep one would otherwise be a place the board cannot be zoomed from.
  if (!whole && terminalHasScrollToGive(event.target)) return
  dispatchWheelToCanvas(event, whole ? event.deltaX : 0, event.deltaY)
}

/**
 * What `Ctrl+V` has always meant on a terminal, and what a program reads as "paste".
 *
 * It is not the image — a bitmap cannot travel over a PTY. It is the keystroke the program
 * in the block acts on by going to the system clipboard itself, which is how a screenshot
 * reached an agent running here before #136 and what this sends again.
 */
const PASTE_BYTE = '\x16'

/**
 * Whether this paste is one the shell cannot be given, so the byte goes instead.
 *
 * The whole rule, and it is written on **what the clipboard is offering** rather than on
 * which chord fired. That is #224: `Ctrl+V` is left to the browser (see the key handler
 * below), and the browser's paste into xterm reads one flavour —
 * `clipboardData.getData('text/plain')` — so a clipboard holding a bitmap and no text
 * pastes an empty string and the program is sent nothing at all. Not the image, and no
 * longer the `\x16` it would have used to go and fetch the image.
 *
 * **Text wins where the clipboard offers both.** Text paste is the older promise and the
 * one pasting a path or a command relies on; the opposite is defensible and this is the
 * call made rather than a fact discovered.
 *
 * And an *empty* clipboard is nothing rather than an image: a rule written as "no text"
 * would fire on every paste of nothing and send a `\x16` nobody asked for.
 */
function pasteIsImageOnly(data: DataTransfer | null): boolean {
  if (!data) return false
  if (data.getData('text/plain')) return false
  return clipboardImages<File>(data).length > 0
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
  /**
   * Whether this session's output arrives with no carriage returns in it.
   *
   * True for a session on pipes, and that is the whole of the rule. A pipe is not a terminal
   * and carries no output translation: a program writes `\n`, `\n` is what comes out, and
   * xterm's default `convertEol: false` moves the cursor down a row and leaves the column
   * exactly where it was — so line two starts where line one ended, line three where line two
   * ended, and the transcript walks diagonally off the right edge. That is #220, seen in an
   * agent tab because a `-p` run is deliberately on pipes, but it is every pipe-mode session's:
   * a machine with no `@lydell/node-pty` binary, or a board started with
   * `EXCALIDRAW_TERMINAL_PTY=0`, staircases every `ls` the same way.
   *
   * A pseudoterminal does the translation itself, which is why a pty tab never showed it and
   * why this is keyed to the mode rather than turned on for everyone. The one thing
   * `convertEol` also rewrites is a bare LF meant as "down one row, same column" by a program
   * repainting a screen — and on pipes no such program runs, since `stdin.isTTY` is false and
   * a full-screen program takes its non-interactive path there. That is this repository's own
   * reason for preferring a PTY, and keying the option to the mode keeps the argument true.
   *
   * Here rather than in the renderer, because the renderer is one producer of many and its
   * bytes are read by the raw tap, `extractGithubUrl` and `UsageMeter` — #219 exists to keep
   * those unchanged. Nothing on the server sees a different byte for this.
   */
  convertEol: boolean
  onData: (data: string) => void
  registerFocus: (focus: (() => void) | null) => void
  isBoardHotkey: (event: KeyboardEvent) => boolean
}> = ({ active, fontSize, cols, rows, output, ended, theme, convertEol, onData, registerFocus, isBoardHotkey }) => {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  /** How much of `output` has been handed to the emulator, so a redraw is a delta. */
  const writtenRef = useRef<string>('')
  const onDataRef = useRef(onData)
  const registerFocusRef = useRef(registerFocus)
  // Through a ref for the reason the other two are: the emulator is built once, in an effect
  // that must not depend on a prop React hands over fresh on every render.
  const isBoardHotkeyRef = useRef(isBoardHotkey)
  onDataRef.current = onData
  registerFocusRef.current = registerFocus
  isBoardHotkeyRef.current = isBoardHotkey

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
      // Named at construction as well as pushed below, so the first chunk of a session that
      // opened before this block did is drawn straight too. See the prop.
      convertEol,
      // The theme this block is *opened* in. It is pushed again below whenever the board's
      // changes — this effect must not depend on it, or a toggle would rebuild the emulator.
      theme: terminalXtermTheme(theme)
    })
    terminal.open(host)
    terminal.onData((data) => onDataRef.current(data))

    // The keystrokes a browser, a board and a shell all claim, settled the way this machine's
    // own terminal settles them. Everything else is the shell's, which is the whole point of
    // the block taking the keyboard.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true

      // The board's four keys are the board's, even in here. #177: the reader asked to be
      // able to navigate the canvas without clicking out of the terminal first, and the
      // comment on it was "it should not send it to the terminal" — so this is not only a
      // matter of letting the key through. Returning false is what does both: xterm stops
      // before it writes the meta escape, and it stops *without* calling `preventDefault`,
      // so the event goes on bubbling to the listeners on `window`. Four Readline word
      // motions are what the shell gives up for it, named in `docs/terminal.md`.
      if (isBoardHotkeyRef.current(event)) return false

      // The word motions and the line ends, sent as bytes measured against both line editors
      // rather than left to whatever xterm decided — #186, and `terminal-keys.ts` is the
      // whole table. It is asked *before* the bail below, which returns early for every
      // `altKey` chord and would leave a macOS `Option` entry unreachable.
      //
      // `preventDefault` is ours to call here. xterm cancels the event itself for the keys it
      // handles, and returning false means it never gets that far — without it the browser
      // would still do its own thing with the chord, and its own thing for `Alt+Left` is to
      // navigate back out of the board.
      const editing = terminalEditingChord(event, macKeyboard())
      if (editing) {
        event.preventDefault()
        onDataRef.current(editing)
        return false
      }

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
      // `\x16` that Ctrl+V means on a terminal whether or not there was anything to paste.
      // Returning false is what leaves the default alone — xterm's own key handling would
      // have cancelled the event.
      //
      // What the shell gets is then decided at the paste, where the clipboard's contents are
      // knowable and the chord no longer matters: text pastes, and a screenshot sends the
      // `\x16` after all, since a bitmap cannot travel over a PTY. See `onPasteCapture` on
      // the card below.
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

  // Before the transcript is written, and that ordering is the point: a session's mode arrives
  // on the same poll its scrollback does, so this effect and the one below fire in the same
  // commit, and the one that decides where a line lands has to run first. Pushed rather than
  // only named above because a tab whose status has not landed yet is drawn before it has a
  // mode to key on — and it never changes afterwards, so this settles once and stays.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.convertEol = convertEol
  }, [convertEol])

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
 * Which rows of a folded transcript the reader has opened, kept where a reload can find them.
 *
 * A fold is a reading position rather than board data: it belongs to whoever is watching, it
 * is not part of what the run did, and a second board open on the same session has no business
 * being folded the same way. So it is neither in the scene nor on the server — nothing about it
 * is synced, exported or committed, for the reason the transcript itself is an overlay.
 *
 * Keyed by session, because a session's ids are only unique inside it: a real run's tool calls
 * carry the agent's own `toolu_…`, but a stream that named none gets `t1`, `t2`, and `s1` on
 * a board restarted yesterday is not `s1` today. Worst case is a row that comes back open on a
 * session that never had it, which costs a click.
 */
const FOLD_STORE = 'excalidraw.terminal.folds'

/** How many open rows one session remembers. A reader who opened a hundred has a fold problem. */
const FOLD_STORE_LIMIT = 200

function readOpenFolds(sessionId: string): Set<string> {
  try {
    const raw = window.localStorage?.getItem(`${FOLD_STORE}:${sessionId}`)
    const ids = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])
  } catch {
    // No storage, or something that is not a list. A transcript that folds from scratch is
    // the whole feature; losing the positions is not worth refusing to draw.
    return new Set()
  }
}

function writeOpenFolds(sessionId: string, open: Set<string>): void {
  try {
    const ids = [...open].slice(-FOLD_STORE_LIMIT)
    window.localStorage?.setItem(`${FOLD_STORE}:${sessionId}`, JSON.stringify(ids))
  } catch { /* private mode, or the quota. The fold still works for this page. */ }
}

/** One tool call, folded shut, and everything the click has to reveal. */
interface FoldItem {
  kind: 'fold'
  id: string
  /** The row that stands for the call: `⏺ Bash(…)`, in the colours #242 gave it. */
  head: FoldSegment[]
  /** The clipped preview the transcript carries, which is the fallback when the detail is gone. */
  preview: string[]
}

/** Anything that is not a tool call: prose, a thinking mark, a line the agent printed itself. */
interface LineItem {
  kind: 'line'
  segments: FoldSegment[]
}

/**
 * A line, in the ink the renderer wrote it in.
 *
 * #242's colour vocabulary is SGR sequences, resolved against whichever of the two palettes the
 * reader is in — which an emulator does for itself and a document has to be told. `slot` is one
 * of the sixteen by name, or since #258 the seventeenth, and `ink` is that theme's map, so a
 * theme toggle repaints this the way it repaints the emulator beside it, out of the same table.
 */
function paint(segments: FoldSegment[], ink: Record<string, string>): React.ReactNode {
  if (!segments.length) return ' '
  return segments.map((segment, index) => (
    <span key={index} style={segment.slot ? { color: ink[segment.slot] } : undefined}>{segment.text}</span>
  ))
}

/**
 * A transcript's rows, with every tool call collapsed into the one row that stands for it.
 *
 * Grouped by id rather than by adjacency, and that is not a detail: a `tool_result` arrives in
 * its own envelope and anything the agent said in between — a `✻ thinking…` mark, a sentence —
 * lands between the call and its answer. Adjacency would make those two groups with one id
 * between them, and a fold that opened twice.
 *
 * A continuation row whose head is not in the transcript is drawn as an ordinary line rather
 * than swallowed: the scrollback has a ceiling, so the top of a long run is a transcript that
 * begins in the middle of somebody's `Read`.
 */
function foldItems(rows: FoldRow[]): (FoldItem | LineItem)[] {
  const items: (FoldItem | LineItem)[] = []
  const open = new Map<string, FoldItem>()
  for (const row of rows) {
    if (row.id && row.head) {
      const item: FoldItem = { kind: 'fold', id: row.id, head: row.segments, preview: [] }
      open.set(row.id, item)
      items.push(item)
      continue
    }
    const owner = row.id ? open.get(row.id) : undefined
    if (owner) owner.preview.push(row.text)
    else items.push({ kind: 'line', segments: row.segments })
  }
  return items
}

/** What an opened row shows, when the record behind it is still in the scrollback. */
const FoldDetailView: React.FC<{ detail: FoldDetail }> = ({ detail }) => (
  <div className="terminal-transcript__detail">
    <div className="terminal-transcript__detail-label">{detail.name || 'tool'} — what was sent</div>
    <pre className="terminal-transcript__detail-text">{detail.input || '(nothing)'}</pre>
    <div className="terminal-transcript__detail-label">what came back</div>
    <pre className="terminal-transcript__detail-text">
      {detail.result === null ? '(still running)' : (detail.result || '(no output)')}
    </pre>
  </div>
)

/**
 * One session's transcript, as a document rather than as a screen.
 *
 * This is the other half of #246, and the reason it is a second component rather than a mode of
 * the emulator above: a fold is a *document* affordance. An xterm grid has no line identity, no
 * region ownership and no hit target — it is a screen being painted, and a row of it is whatever
 * happens to be at that y. Nothing can be hung off a row that does not exist.
 *
 * The trade an emulator was bought with is therefore not being made here, and it is worth saying
 * which trade: xterm parses cursor moves, colours and the alternate screen, which is what a
 * program repainting itself needs. **Nothing repaints in here.** This view is drawn only for a
 * transcript carrying the board's own fold marks, and only `AgentStreamRenderer` writes those —
 * which happens only for a command with `--output-format stream-json` in it, which Claude Code
 * accepts only beside `--print`. So the session is headless by construction: its stdin went to a
 * prompt and ended there, it is `readOnly` in the summary, and there is no keyboard to give up.
 * A reader who opens such a command by hand as an ordinary shell gets this view too, and loses
 * the keyboard with it — a corner nobody reaches through the board's own buttons.
 *
 * The fold state is the reader's and lives in `localStorage` above, so it survives the reload
 * that the transcript itself survives by being replayed out of the server's scrollback.
 */
const TerminalTranscript: React.FC<{
  active: boolean
  sessionId: string
  output: string
  ended: string | null
  /** The board's, so #242's slot references resolve against the palette the reader is in. */
  theme: TerminalTheme
}> = ({ active, sessionId, output, ended, theme }) => {
  const { rows, details } = useMemo(() => parseFoldedTranscript(output), [output])
  const items = useMemo(() => foldItems(rows), [rows])
  // The same sixteen the emulator in the tab beside this one is themed from, so the two cannot
  // disagree about what `cyan` is on this board — plus the ink that only exists here. #258: an
  // orange is not one of the sixteen and cannot be written as SGR, so it arrives as a *name* and
  // is resolved at this point, which is the first one that knows which theme the reader is in.
  // A tab drawn by the emulator never sees it and does not have to: it draws the mark as nothing
  // and the line lands on the default ink.
  const ink = useMemo(() => terminalDocumentInk(theme), [theme])
  const [open, setOpen] = useState<Set<string>>(() => readOpenFolds(sessionId))
  const boxRef = useRef<HTMLDivElement>(null)
  /** Whether the reader is still at the end of the run, which is where new lines arrive. */
  const pinnedRef = useRef(true)

  const toggle = (id: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeOpenFolds(sessionId, next)
      return next
    })
  }

  // Follow the end of the run, unless the reader has scrolled back to read something. Same
  // rule an emulator's scrollback follows, and for the same reason: a transcript that jumped
  // to the bottom every time a line arrived would be unreadable while a run is working.
  useEffect(() => {
    const box = boxRef.current
    if (!box || !pinnedRef.current) return
    box.scrollTop = box.scrollHeight
  }, [output, open, active, ended])

  return (
    <div
      className="terminal-card__screen terminal-transcript"
      // The line box the grid was derived from, named from the same constant the emulator is
      // built with rather than spelled again in the stylesheet — a transcript and a screen in
      // two tabs of one block have to be set at the same rhythm or the block has two.
      style={{ visibility: active ? 'visible' : 'hidden', lineHeight: TERMINAL_LINE_HEIGHT }}
      data-session={sessionId}
      ref={boxRef}
      onScroll={(event) => {
        const box = event.currentTarget
        pinnedRef.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 2
      }}
      // A wheel this document has no use for goes to the board, exactly as a wheel the
      // emulator's scrollback has no use for does — see `forwardWheelToCanvas`. The browser
      // scrolls this box itself and never calls `preventDefault`, so without this the board
      // would pan at the same time as the transcript scrolled.
      //
      // **"No use for" is the box having nothing to scroll, not this wheel reaching an end**,
      // which is #256 on this side of the block: the rule used to read the direction too, so a
      // reader at the top or the bottom of a run had the next notch pan the canvas away. The
      // same question the emulator is asked, so a block with a shell in one tab and a run in
      // another answers the wheel the same way in both.
      onWheel={(event) => {
        const box = boxRef.current
        if (!box) return
        if (box.scrollHeight > box.clientHeight + SCROLLBACK_SLACK_PX) event.stopPropagation()
      }}
    >
      {items.map((item, index) => (item.kind === 'line' ? (
        <div key={index} className="terminal-transcript__line">{paint(item.segments, ink)}</div>
      ) : (
        <div
          key={index}
          className={`terminal-transcript__fold${open.has(item.id) ? ' terminal-transcript__fold--open' : ''}`}
          data-fold={item.id}
        >
          {/* The whole row is the target, not a caret beside it. The ask was to click on the
              tool call, and a reader aiming at a triangle the width of one character in a
              block that may be zoomed out is aiming at nothing. */}
          <div
            className="terminal-transcript__row"
            role="button"
            tabIndex={0}
            aria-expanded={open.has(item.id)}
            title={open.has(item.id) ? 'fold this tool call away' : 'show what was sent and what came back'}
            onClick={() => toggle(item.id)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              toggle(item.id)
            }}
          >
            <span className="terminal-transcript__caret">{open.has(item.id) ? '▾' : '▸'}</span>
            <span className="terminal-transcript__head">{paint(item.head, ink)}</span>
          </div>
          {open.has(item.id) && (details[item.id]
            ? <FoldDetailView detail={details[item.id]} />
            // The record has been trimmed out of the scrollback but the rows it marked are
            // still here. The clipped preview is what the block always showed, so showing it
            // is a fold that reveals less rather than a fold that reveals nothing.
            : <pre className="terminal-transcript__detail-text">{item.preview.join('\n')}</pre>)}
        </div>
      )))}
      {ended && <div className="terminal-transcript__line">[{ended}]</div>}
    </div>
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
  onSelect, onAdd, onClose, onDetach, onMerge, onInput, isBoardHotkey,
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
        ...({
          ...terminalCssVars(theme),
          // The scrollback bar's strip, in the pixels it is drawn in rather than the scene
          // units the grid reserved. Here rather than in the stylesheet because it is the
          // *same* number `terminalGrid()` subtracts — a bar sized by a length in the CSS and
          // a strip reserved by a constant in TypeScript is two numbers that drift, and the
          // one they drift into is the last column drawn under the bar. `fontSize` below is
          // already the reader's size times the board's zoom, so the strip scales with the
          // card exactly as the frame around it does.
          '--terminal-scrollbar': `${terminalScrollbar(fontSize)}px`
        } as React.CSSProperties),
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
      //
      // Except the four the board navigates by. React's `stopPropagation` calls the native
      // one, and React listens at its own root — *below* `window` — so a chord stopped here
      // never reaches the four listeners at all. That is the layer #177 did not name, and the
      // reason letting the key past xterm alone changed nothing a reader could see. What goes
      // on past this point is an `Alt` chord, which is not one of the bare letters Excalidraw
      // binds, and the handler that catches it calls `preventDefault` itself.
      onKeyDown={(event) => { if (!isBoardHotkey(event.nativeEvent)) event.stopPropagation() }}
      onKeyUp={(event) => { if (!isBoardHotkey(event.nativeEvent)) event.stopPropagation() }}
      // A screenshot, which the shell cannot be handed, offered to the program as the
      // keystroke that fetches one — see `pasteIsImageOnly` above for the rule and #224 for
      // the observation.
      //
      // **At the paste rather than in the key handler, and that is both of the reasons it
      // is here.** A `keydown` cannot know what the clipboard holds — the chord has not
      // fired the default action yet — and a rule written at the paste event is
      // keyboard-agnostic, so `Cmd+V` on a Mac comes for free with no second entry in
      // `terminal-keys.ts`. The key handler returns false for both chords already, which is
      // what leaves the browser's own paste to fire for either one.
      //
      // **In the capture phase**, for the reason `forwardHorizontalWheelToCanvas` is: xterm
      // listens for `paste` on its own hidden textarea, which is *below* this card, and it
      // stops the event there. The capture pass goes root-first and has already happened by
      // then, so stopping it here is what keeps the emulator from also pasting the empty
      // string this clipboard would give it.
      onPasteCapture={(event) => {
        if (!pasteIsImageOnly(event.clipboardData)) return
        event.preventDefault()
        event.stopPropagation()
        // Dropped rather than posted for a read-only session, for the reason `onData` is:
        // the route refuses one, and a block that posted anyway would be asking for a 409
        // to learn what its own status already told it.
        if (active && !active.status?.readOnly) onInput(active.id, PASTE_BYTE)
      }}
    >
      <div className="terminal-card__header">
        <span className="terminal-card__where" title={status?.cwd ?? ''}>{status?.cwd ?? ''}</span>
        <span className="terminal-card__grid">{status ? `${status.cols}×${status.rows}` : ''}</span>

        {/* The reader's own size, and one of the three things on this overlay that take a
            click.
            Buttons rather than a shortcut because while the terminal has the keyboard a
            keystroke belongs to the shell unless something claimed it by name — Ctrl+- would
            reach the shell, not the block. #177 claimed the four board keys and no more.
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

        {/* And what the tab *is*, when it is not a shell. A session whose stdin went to an
            agent's prompt has nothing for a keystroke to reach, and a block that said
            nothing about it left the reader typing into a screen that answered by staying
            exactly as it was. */}
        {status?.readOnly ? (
          <span
            className="terminal-card__mode"
            title="An agent's prompt was written to this session's stdin and ended there, so
                   there is nothing left to type into. Its output is the whole of it."
          >read-only</span>
        ) : null}
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
          >⇤</span>
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
        {/* `onData` is dropped rather than posted for a read-only session: the route refuses
            one, and a block that posted anyway would be asking for a 409 per keystroke to
            learn what its own status already told it.

            **Which of the two views a tab gets is asked of the transcript**, not of the
            session's flags, and that is #246. A transcript carrying fold marks is one the
            board composed itself out of `stream-json` — see `agent-stream-render.ts` — so it
            is a log with line identity rather than a screen, and it is drawn as a document
            that folds. Everything else is a program's own repaints and stays in the emulator,
            byte for byte as it was.

            A rendered session opens with prose before its first tool call, so such a tab is
            an emulator for its first few lines and a document afterwards. The flip disposes
            an xterm that has drawn only what this view then draws again, which is why it is
            not worth guessing the mode from the summary ahead of the evidence. */}
        {tabs.map((tab) => (hasFoldMarks(tab.output) ? (
          <TerminalTranscript
            key={tab.id}
            active={tab.id === active?.id}
            sessionId={tab.id}
            output={tab.output}
            ended={tab.ended}
            theme={theme}
          />
        ) : (
          <TerminalScreen
            key={tab.id}
            active={tab.id === active?.id}
            fontSize={fontSize}
            cols={Math.max(2, tab.status?.cols ?? 80)}
            rows={Math.max(1, tab.status?.rows ?? 24)}
            output={tab.output}
            ended={tab.ended}
            theme={theme}
            // One emulator per session and every one of them kept alive, so this is per tab:
            // the pipe-mode tab beside a pty one is the only one told to translate.
            convertEol={tab.status?.mode === 'pipe'}
            onData={(data) => { if (!tab.status?.readOnly) onInput(tab.id, data) }}
            // Asked whatever the tab's stdin is. A read-only session drops keystrokes, but
            // the four board keys were never the session's to drop — they navigate the
            // canvas, and a reader watching a headless run has the same board to get back to.
            isBoardHotkey={isBoardHotkey}
            registerFocus={(focus) => {
              if (focus) focusRef.current.set(tab.id, focus)
              else focusRef.current.delete(tab.id)
            }}
          />
        )))}

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
