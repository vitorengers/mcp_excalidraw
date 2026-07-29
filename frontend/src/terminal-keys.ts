/**
 * The editing chords the terminal block owns, and the bytes each one sends — one table.
 *
 * Everything a reader presses in the block is xterm.js's business, and that is right for
 * nearly all of it. Word motions are the exception, and #186 is what that cost: xterm hands
 * `Ctrl+Backspace` over as `\b`, which is also `Ctrl+H`, which readline reads as
 * `backward-delete-char` — one character. It only ever looked correct on Windows because
 * ConPTY rewrites an incoming `0x08` into a `VK_BACK + LEFT_CTRL` key event
 * (microsoft/terminal#3935), which is what fires PSReadLine's `BackwardKillWord`. No such
 * rewrite reaches `bash`. The macOS `Cmd` family fared worse: xterm drops `Cmd+Left` and
 * `Cmd+Right` on the floor (`if (ev.metaKey) break;`) and sends one `DEL` for
 * `Cmd+Backspace`, because that branch never consults `metaKey` at all.
 *
 * So the block claims them, and the reason to claim *all* of them rather than only the broken
 * ones is that xterm has already removed its own alt-to-word hack for 6.0
 * (xtermjs/xterm.js#4538), telling embedders to own this. A table that is ours does not
 * change under an upgrade.
 *
 * **Every sequence below was measured against both line editors** — PSReadLine over ConPTY
 * and readline in `bash` — rather than reasoned about, because the two disagree in ways no
 * amount of reading settles. What the measurement found, and why the table says what it says:
 *
 * | intent                    | sent        | why not the obvious alternative                  |
 * |---------------------------|-------------|--------------------------------------------------|
 * | word left / right         | `ESC[1;5D/C`| `ESC b`/`ESC f` print a literal `b`/`f` on ConPTY |
 * | delete the word left      | `^W`        | `\b` is one character on readline; `ESC DEL`      |
 * |                           |             | prints a literal `^H` on ConPTY                   |
 * | delete the word right     | `ESC[3;5~`  | `ESC d` also works on both; this one *is*         |
 * |                           |             | `Ctrl+Delete`, so it stays true if a reader looks |
 * | the start / end of a line | `ESC[H`/`F` | `^A` is `SelectAll` in PSReadLine, `^E` prints    |
 * | delete to the line start  | see below   | no sequence does it in both — the one place       |
 * |                           |             | this table has to ask which keyboard is in front  |
 *
 * `^W` costs one thing worth writing down: readline's `unix-word-rubout` is delimited by
 * whitespace and PSReadLine's `BackwardKillWord` by a punctuation set, so `foo/bar-baz` goes
 * in one press under `bash` and three under PowerShell. The alternative was one press that
 * works and one that types `^H` into the reader's command line, which is not a choice.
 */

/** What this table needs of a `KeyboardEvent`, so it can be asked about a plain object too. */
export interface EditingKeyChord {
  code: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** Word motions. `Ctrl+Left` / `Ctrl+Right`, and what `Option` means on a Mac. */
const WORD_LEFT = '\x1b[1;5D'
const WORD_RIGHT = '\x1b[1;5C'
const MAC_WORD_LEFT = '\x1bb'
const MAC_WORD_RIGHT = '\x1bf'

/** Word deletions. */
const KILL_WORD_LEFT = '\x17'
const KILL_WORD_RIGHT = '\x1b[3;5~'
const MAC_KILL_WORD_LEFT = '\x1b\x7f'
const MAC_KILL_WORD_RIGHT = '\x1bd'

/** Line ends. */
const LINE_START = '\x1b[H'
const LINE_END = '\x1b[F'

/**
 * Delete to the start of the line, which is the one row with two answers.
 *
 * `^U` is readline's `unix-line-discard` and ZLE's `kill-whole-line`; PSReadLine has no
 * binding for it and prints `^U` into the line it was meant to clear. `ESC[1;5H` is
 * `Ctrl+Home`, which is PSReadLine's `BackwardDeleteLine` and which readline ignores in
 * silence. Both measured, both ways.
 *
 * So the keyboard decides, and the keyboard is the best proxy available for the line editor:
 * this board is served over loopback, so the browser is nearly always on the machine the
 * shell is on. `Cmd+Backspace` is a macOS chord in the first place, and a Mac runs a Mac
 * shell — the cross case, a Mac browser driving a Windows board, gets a printed `^U` rather
 * than a wrong deletion.
 */
const KILL_LINE_LEFT_MAC = '\x15'
const KILL_LINE_LEFT_OTHER = '\x1b[1;5H'

/**
 * Is the reader on a Mac keyboard?
 *
 * `userAgentData.platform` first and `navigator.platform` behind it, which is the order
 * xterm.js itself uses (`@xterm/xterm/src/common/Platform.ts`) — the second is deprecated and
 * the first is not everywhere yet. Asked on the press rather than cached at module load, so
 * nothing depends on which of the two the page happened to have when it started.
 */
export function macKeyboard(): boolean {
  if (typeof navigator === 'undefined') return false
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const named = data?.platform || navigator.platform || ''
  if (named) return /mac/i.test(named)
  return /Mac OS X/.test(navigator.userAgent || '')
}

/**
 * The bytes this chord should send the shell, or null to leave it to xterm.
 *
 * Null is most of the keyboard, and deliberately: the block exists to hand a shell the
 * keyboard, and every key this table does not name is one xterm already sends correctly.
 *
 * Three shapes are turned down before the table is consulted at all:
 *
 * - **anything with `Shift`.** `Shift+Ctrl+Left` selects a word in a text box, and a shell
 *   has no selection to grow — xterm's `ESC[1;6D` is the honest answer and stays.
 * - **anything with more than one of `Ctrl`, `Alt` and `Meta`.** `Ctrl+Alt` is how AltGr
 *   arrives on several layouts, and that is somebody typing a `@`. `TerminalPanel.tsx`
 *   already turns on that distinction and this keeps the two answers the same one.
 * - **`Alt` off a Mac.** There it is a third-level shift rather than `Option`, and xterm's
 *   own mapping of `Alt+Left` is already the word motion this table would send. Taking it
 *   would be claiming a key for no change.
 */
export function terminalEditingChord(event: EditingKeyChord, isMac: boolean): string | null {
  if (event.shiftKey) return null
  const claimed = Number(event.ctrlKey) + Number(event.altKey) + Number(event.metaKey)
  if (claimed !== 1) return null
  if (event.altKey && !isMac) return null

  if (event.metaKey) {
    if (event.code === 'ArrowLeft') return LINE_START
    if (event.code === 'ArrowRight') return LINE_END
    if (event.code === 'Backspace') return isMac ? KILL_LINE_LEFT_MAC : KILL_LINE_LEFT_OTHER
    return null
  }

  if (event.altKey) {
    if (event.code === 'ArrowLeft') return MAC_WORD_LEFT
    if (event.code === 'ArrowRight') return MAC_WORD_RIGHT
    if (event.code === 'Backspace') return MAC_KILL_WORD_LEFT
    if (event.code === 'Delete') return MAC_KILL_WORD_RIGHT
    return null
  }

  if (event.code === 'ArrowLeft') return WORD_LEFT
  if (event.code === 'ArrowRight') return WORD_RIGHT
  if (event.code === 'Backspace') return KILL_WORD_LEFT
  if (event.code === 'Delete') return KILL_WORD_RIGHT
  return null
}
