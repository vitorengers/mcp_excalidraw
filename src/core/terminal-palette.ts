/**
 * What the terminal is coloured with — one palette, in one place, for all three surfaces.
 *
 * There are three of them and they are drawn by three different things: the **shape** is an
 * Excalidraw rectangle with a fill and a stroke, the **emulator** is xterm, which takes a
 * theme object and paints its own backdrop and glyphs from it, and the **frame** around it —
 * the header, the tabs, the prompt row — is a stylesheet. Before #115 each of those carried
 * its own hexes, the same Catppuccin Mocha spelled out three times, and they had already
 * drifted: a "dark" that was `#1e1e2e` in two files and `rgb(205 214 244 / 6%)` in the third.
 * A stylesheet cannot import TypeScript, so the way the three are held together is that the
 * overlay writes `TERMINAL_CSS_VARS` onto its own root and `TerminalPanel.css` reads nothing
 * but `var(--terminal-*)`.
 *
 * ## Why paper
 *
 * This reverses a decision that was written down twice — a terminal that follows the canvas
 * into light mode stops looking like one, and a dark shape reads as a terminal at a zoom
 * where the shape is all there is to read. Both were true of a board that no longer exists.
 * Every other region of this one is a pale block with a hand-drawn label, and the terminal
 * was the single rectangle in another design language. #115 asked for the board's design,
 * "a paper kindle look alike, but with colors", and that is what these values are.
 *
 * The second half of that decision is not free, and `TERMINAL_BAND` is what pays for it. See
 * the note there.
 *
 * ## Why these colours and not the board's own
 *
 * The blocks are filled from five pastels (`#e7f5ff`, `#ebfbee`, `#fff9db`, `#ffe3e3`,
 * `#f3f0ff`) and there are sixteen ANSI slots to fill, so the pastels cannot be the source:
 * sixteen invented tints of five hues stop being distinguishable long before the list ends.
 * The source is Catppuccin **Latte**, the light counterpart of the Mocha this replaces, whose
 * text colour `#4c4f69` the block's stroke was already drawn in.
 *
 * Latte is a palette for a user interface, though, and roughly half of it fails as *ink*: on
 * paper its yellow is 2.4:1, its `surface2` "white" is 2.0:1. So every entry below was
 * checked against `TERMINAL_PAPER` and darkened until it cleared **3:1**, which
 * `scripts/check-terminal-paper-browser.mjs` then asserts of a real render rather than of
 * this file. The hues are Latte's; the lightness is this board's.
 */

/** The surface. Warm rather than Latte's own cool `#eff1f5`: the observation asked for paper. */
export const TERMINAL_PAPER = '#faf6ee';

/** The default ink. Latte's text colour, which the block's stroke was already drawn in. */
export const TERMINAL_INK = '#4c4f69';

/** Ink for what is beside the point — a hint, a path, an inactive tab. 3.3:1, still ink. */
export const TERMINAL_INK_DIM = '#83869a';

/** The one accent, kept green because that is what the cursor and the caret already were. */
export const TERMINAL_ACCENT = '#3f8f24';

/** What a destructive control turns when the pointer is on it. */
export const TERMINAL_ALERT = '#d20f39';

/**
 * The bands across the top and bottom of the frame, and the answer to "what says terminal
 * when the text has gone".
 *
 * The dark fill used to do that job, and paper cannot: at a zoom where the overlay's text is
 * four pixels tall there is nothing to read but the shape, and a pale rectangle on a board of
 * pale rectangles is one more block. So the thing that carries the identity moves from the
 * fill to a *band* — the header and the prompt row get a solid dark strip each, and what is
 * left is a paper card with a bar top and bottom. That is an area rather than a glyph, so it
 * survives being shrunk; the check asserts it at zoom 0.15, where the text is under five
 * pixels and nothing on the card can be read.
 *
 * It is the ink colour rather than a fourth one, so the card is two values and not four.
 */
export const TERMINAL_BAND = TERMINAL_INK;

/** Text on a band. 6.5:1 against it, and warm, so the bar reads as printed rather than lit. */
export const TERMINAL_BAND_INK = '#ece7db';

/** Secondary text on a band — the grid readout, the mode chip. 4.1:1. */
export const TERMINAL_BAND_DIM = '#b6b8c6';

/**
 * The accent, on a band.
 *
 * A second value rather than a reuse, because an accent chosen to be legible on paper is
 * 2:1 on the band and disappears there — the caret at the bottom of the frame is the same
 * mark as the cursor in the screen above it and has to read as one in both places.
 */
export const TERMINAL_BAND_ACCENT = '#8ed67a';

/** A hairline between the paper and something on it. Not ink; it is a fold, not a mark. */
export const TERMINAL_RULE = '#e2dbc9';

/** What a tab chip sits on, so the strip reads as tabs rather than as words in a row. */
export const TERMINAL_CHIP = '#f1ead9';

/** Selected text. Ink stays at 5.6:1 on it, which is what a highlight has to leave alone. */
export const TERMINAL_SELECTION = '#dfd7c4';

/**
 * The sixteen, each one at least 3:1 on the paper above.
 *
 * The **greys are the awkward ones**, and no light terminal theme escapes it. On a dark
 * background the ramp runs black → bright white from least ink to most; on paper "white" is
 * the colour of the page, so a program that asks for white text is asking for nothing. The
 * ramp is therefore read as *contrast* rather than as lightness: `black` and `white` are both
 * mid inks, `brightBlack` is the dim one every tool uses for comments and secondary text, and
 * `brightWhite` is the strongest ink, which is what a program means when it asks for it.
 *
 * The cost is that `black` and `white` are two similar greys, so a program that distinguishes
 * them will not be distinguished here. That is inherent to printing sixteen colours on paper
 * and is written down in `docs/terminal.md` rather than hidden.
 *
 * "Bright" is likewise more ink rather than more light: a bright colour is the darker, more
 * saturated member of its pair, so emphasis still reads as emphasis.
 */
export const TERMINAL_ANSI = {
  black: '#5c5f77',
  red: '#d20f39',
  green: '#3f8f24',
  yellow: '#a6791a',
  blue: '#1e66f5',
  magenta: '#c0399f',
  cyan: '#0e7c86',
  white: '#6c6f85',
  brightBlack: '#83869a',
  brightRed: '#e64553',
  brightGreen: '#2f7d16',
  brightYellow: '#8a6412',
  brightBlue: '#5566d8',
  brightMagenta: '#8839ef',
  brightCyan: '#0f6f95',
  brightWhite: '#4c4f69',
} as const;

/**
 * The whole theme xterm is opened with.
 *
 * All twenty-one entries, deliberately. A theme that sets five leaves the other sixteen at
 * xterm's own defaults, which are tuned for a dark background — that is how the yellow, the
 * bright white and the bright cyan ended up at 1.1:1 on paper, which is not a colour anyone
 * chose, it is the colour nobody set.
 *
 * `cursorAccent` is the glyph *under* a block cursor, so it is the paper: the cursor is a
 * stamp of accent with the character punched out of it.
 */
export const TERMINAL_THEME = {
  background: TERMINAL_PAPER,
  foreground: TERMINAL_INK,
  cursor: TERMINAL_ACCENT,
  cursorAccent: TERMINAL_PAPER,
  selectionBackground: TERMINAL_SELECTION,
  ...TERMINAL_ANSI,
} as const;

/**
 * The same palette as custom properties, for the half of the frame a stylesheet draws.
 *
 * Written onto the card's own root by `TerminalPanel.tsx` rather than onto `:root`, so a
 * board with two terminal blocks is two independent surfaces and nothing leaks into the
 * canvas around them.
 */
export const TERMINAL_CSS_VARS: Record<string, string> = {
  '--terminal-paper': TERMINAL_PAPER,
  '--terminal-ink': TERMINAL_INK,
  '--terminal-ink-dim': TERMINAL_INK_DIM,
  '--terminal-accent': TERMINAL_ACCENT,
  '--terminal-alert': TERMINAL_ALERT,
  '--terminal-band': TERMINAL_BAND,
  '--terminal-band-ink': TERMINAL_BAND_INK,
  '--terminal-band-dim': TERMINAL_BAND_DIM,
  '--terminal-band-accent': TERMINAL_BAND_ACCENT,
  '--terminal-rule': TERMINAL_RULE,
  '--terminal-chip': TERMINAL_CHIP,
  '--terminal-selection': TERMINAL_SELECTION,
};
