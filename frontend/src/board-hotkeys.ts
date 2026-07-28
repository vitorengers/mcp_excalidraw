/**
 * When a board hotkey stands down — one rule, in one place.
 *
 * Four keys navigate this canvas: `Alt+B` for the mirror, `Alt+T` for the terminal, and one
 * per section the board has drawn a mark around (`src/core/board-sections.ts` — `Alt+P` and
 * `Alt+G` on this project's own board). All four listen on `window`, because Excalidraw never
 * sees a key pressed outside its canvas, and all four have to stand down while something is
 * genuinely being typed into: a card's title, a search field, Excalidraw's own label editor.
 *
 * That test used to be written out three times in `App.tsx`, and it said `TEXTAREA`. #177 is
 * what that cost. **A focused xterm is a focused `TEXTAREA`** — the emulator takes the
 * keyboard through a hidden helper it marks with `xterm-helper-textarea`
 * (`@xterm/xterm/src/browser/Terminal.ts`) — so with the terminal focused the reader had no
 * way to navigate the board at all, and the answer to that was "click the canvas first".
 *
 * The rule is therefore about what the focused node *is* rather than about its tag, and it is
 * exported rather than repeated so that the terminal overlay can ask the same question the
 * listeners ask. Three layers have to agree before one of these keys reaches the board with a
 * terminal focused, and the other two are in `TerminalPanel.tsx`:
 *
 * 1. this rule, so the `window` listener does not stand down;
 * 2. the card's own `keydown` handler, which stops propagation so Excalidraw does not read a
 *    shell's keystrokes as tools — React's `stopPropagation` calls the native one, so a chord
 *    it stops never reaches `window` at all;
 * 3. xterm's `attachCustomKeyEventHandler`, which otherwise writes the meta escape to the
 *    shell — a board that jumped *and* left an `ESC b` on the command line would be half a fix.
 */

/** The class xterm puts on the hidden textarea it reads the keyboard through. */
export const XTERM_HELPER_TEXTAREA_CLASS = 'xterm-helper-textarea'

/**
 * Is this node the terminal holding the keyboard, rather than a field being typed into?
 *
 * Matched on xterm's own class rather than on the card around it: the class is what makes
 * the node a keyboard host, and a board could one day draw an emulator somewhere that is not
 * a `.terminal-card`.
 */
export function isTerminalKeyboardHost(node: Element | null | undefined): boolean {
  return Boolean(node && node.classList && node.classList.contains(XTERM_HELPER_TEXTAREA_CLASS))
}

/**
 * True when text is genuinely being entered and a board hotkey must not jump the viewport.
 *
 * Every `TEXTAREA`, `INPUT` and `contentEditable` stands the keys down exactly as before —
 * the case this guard exists for is typing `Alt+P` into a card's title and getting a `p`.
 * The terminal is the one exception, and it is an exception because the shell no longer
 * receives these four either: see `TerminalPanel.tsx`.
 */
export function textEntryOwnsKeyboard(active: Element | null | undefined): boolean {
  if (!active) return false
  if (isTerminalKeyboardHost(active)) return false
  return active.tagName === 'TEXTAREA'
    || active.tagName === 'INPUT'
    || (active as HTMLElement).isContentEditable === true
}

/**
 * The shape all four board hotkeys share: `Alt`, and neither `Ctrl` nor `Meta`.
 *
 * The exclusions are not decoration. `Ctrl+Alt` is how AltGr arrives on several layouts, and
 * that is somebody typing a `@` rather than reaching for the board — `TerminalPanel.tsx`
 * already turns on that distinction, and this keeps the two answers the same one.
 */
export function isBoardHotkeyChord(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey'>): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey
}
