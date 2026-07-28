/**
 * What the terminal is coloured with — one palette per theme, in one place, for all three
 * surfaces.
 *
 * There are three of them and they are drawn by three different things: the **shape** is an
 * Excalidraw rectangle with a fill and a stroke, the **emulator** is xterm, which takes a
 * theme object and paints its own backdrop and glyphs from it, and the **frame** around it —
 * the header, the tabs, the prompt row — is a stylesheet. Before #115 each of those carried
 * its own hexes, the same Catppuccin Mocha spelled out three times, and they had already
 * drifted: a "dark" that was `#1e1e2e` in two files and `rgb(205 214 244 / 6%)` in the third.
 * A stylesheet cannot import TypeScript, so the way the three are held together is that the
 * overlay writes `terminalCssVars(theme)` onto its own root and `TerminalPanel.css` reads
 * nothing but `var(--terminal-*)`.
 *
 * ## Why paper, and then why not only paper
 *
 * #115 reversed a decision that had been written down twice — a terminal that follows the
 * canvas into light mode stops looking like one, and a dark shape reads as a terminal at a
 * zoom where the shape is all there is to read. Both were true of a board that no longer
 * exists: every other region of this one is a pale block with a hand-drawn label, and the
 * terminal was the single rectangle in another design language. #115 asked for the board's
 * design, "a paper kindle look alike, but with colors", and the light palette below is what
 * those values are.
 *
 * What #115 also decided, and #147 undecided, is that paper would be the answer in **both**
 * themes. It could not be, and not as a matter of taste: dark mode on this board is a filter
 * Excalidraw puts on the canvas — `.theme--dark canvas { filter: invert(93%)
 * hue-rotate(180deg) }` — and the overlay is a `div` sibling of Excalidraw that nothing
 * filters. So the shape went near-black and the card stayed `#faf6ee`, and the two things
 * this module exists to keep identical were painted eight stops apart. Only one of them can
 * be told what theme it is in, so it is told.
 *
 * ## The shape does not move, and that is what fixes the dark surface
 *
 * The rectangle's fill is `TERMINAL_PAPER` in both themes, exactly like every other block on
 * this board is its own literal pastel in both themes: Excalidraw's filter is what darkens
 * them, and a block that opted out of it would be the one shape on the canvas that did.
 * It is also *scene data* — synced, exported and committed — and the theme is a per-reader
 * setting in `localStorage`, so a fill that followed it would turn every toggle into a change
 * to the board and two readers with different themes into two boards.
 *
 * So the fill stays and the dark palette's surface is defined the other way round: it is the
 * colour `#faf6ee` **comes out** once the filter has had it, `#1d1912`, measured off a real
 * render by `scripts/check-terminal-paper-browser.mjs` rather than asserted here. Warm rather
 * than Catppuccin Mocha's cool `#1e1e2e`, which is the one place the dark palette departs from
 * Mocha, and it departs in the direction of the paper it is the night side of.
 *
 * ## Why these colours and not the board's own
 *
 * The blocks are filled from five pastels (`#e7f5ff`, `#ebfbee`, `#fff9db`, `#ffe3e3`,
 * `#f3f0ff`) and there are sixteen ANSI slots to fill, so the pastels cannot be the source:
 * sixteen invented tints of five hues stop being distinguishable long before the list ends.
 * The source is Catppuccin — **Latte** for the light palette, whose text colour `#4c4f69` the
 * block's stroke was already drawn in, and **Mocha**, Latte's counterpart, for the dark one,
 * which is what this surface was before #115.
 *
 * Neither is usable as shipped, and for the same reason in mirror image: they are palettes
 * for a user interface, and roughly half of each fails as *ink*. On paper Latte's yellow is
 * 2.4:1 and its `surface2` "white" 2.0:1; on the night surface Mocha's own `black` `#45475a`
 * is 1.8:1 and its `surface2` 2.5:1. So every entry below was checked against its own
 * theme's surface and moved — darkened on paper, lifted on night — until it cleared **3:1**,
 * which the check then asserts of a real render in **both** themes. The hues are Catppuccin's;
 * the lightness is this board's.
 */

/** Which of the two the board is in. Excalidraw's own word for it, mirrored by `App.tsx`. */
export type TerminalTheme = 'light' | 'dark';

/** The sixteen a program can ask for by number. */
export interface TerminalAnsi {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Everything the three surfaces need, for one theme. */
export interface TerminalPalette {
  /** The surface. In dark, the colour the shape's fill renders as, not the fill itself. */
  paper: string;
  /** The default ink. */
  ink: string;
  /** Ink for what is beside the point — a hint, a path, an inactive tab. */
  inkDim: string;
  /** The one accent, green in both themes because that is what the cursor and caret are. */
  accent: string;
  /** What a destructive control turns when the pointer is on it. */
  alert: string;
  /** The band across the top of the frame. See the note below. */
  band: string;
  /** Text on a band. */
  bandInk: string;
  /** Secondary text on a band — the grid readout, the mode chip. */
  bandDim: string;
  /**
   * The wash a control on the band sits on, and its border.
   *
   * Three values rather than three literals in the stylesheet, and #121's trap is why: the
   * band is dark in one theme and light in the other, so a fixed white tint that lifts a
   * control off the light band is invisible on the dark one. A set declared in part is worse
   * than a set not declared at all.
   */
  bandWash: string;
  bandWashStrong: string;
  bandEdge: string;
  /** A hairline between the surface and something on it. Not ink; it is a fold, not a mark. */
  rule: string;
  /** What a tab chip sits on, so the strip reads as tabs rather than as words in a row. */
  chip: string;
  /** Selected text, which has to leave the ink on it legible. */
  selection: string;
  ansi: TerminalAnsi;
}

/**
 * Paper.
 *
 * `paper` is warm rather than Latte's own cool `#eff1f5`: the observation asked for paper.
 * `ink` is Latte's text colour, which the block's stroke was already drawn in.
 *
 * **The band is the ink**, and that is the second half of #115's decision rather than a
 * fourth colour. The dark fill used to answer "what says terminal when the text has gone",
 * and paper cannot: at a zoom where the overlay's text is four pixels tall there is nothing
 * to read but the shape, and a pale rectangle on a board of pale rectangles is one more
 * block. So the identity moved from the fill to a *band* — the header gets a solid strip of
 * the strongest colour on the card, across the top of it. That is an area rather than a glyph,
 * so it survives being shrunk; the check asserts it at zoom 0.15, where the text is under five
 * pixels and nothing can be read. There were two such strips, top and bottom, until #144 took
 * the bottom one away; `bandAccent` went with it, since the caret on that strip was the one
 * thing that read it.
 *
 * The sixteen: the **greys are the awkward ones**, and no light terminal theme escapes it. On
 * a dark background the ramp runs black → bright white from least ink to most; on paper
 * "white" is the colour of the page, so a program that asks for white text is asking for
 * nothing. The ramp is therefore read as *contrast* rather than as lightness: `black` and
 * `white` are both mid inks, `brightBlack` is the dim one every tool uses for comments and
 * secondary text, and `brightWhite` is the strongest ink, which is what a program means when
 * it asks for it. The cost is that `black` and `white` are two similar greys, so a program
 * that distinguishes them will not be distinguished here. That is inherent to printing sixteen
 * colours on paper and is written down in `docs/terminal.md` rather than hidden.
 *
 * "Bright" is likewise more ink rather than more light: a bright colour is the darker, more
 * saturated member of its pair, so emphasis still reads as emphasis.
 */
const LIGHT: TerminalPalette = {
  paper: '#faf6ee',
  ink: '#4c4f69',
  inkDim: '#83869a',
  accent: '#3f8f24',
  alert: '#d20f39',
  band: '#4c4f69',
  bandInk: '#ece7db',
  bandDim: '#b6b8c6',
  bandWash: 'rgb(255 255 255 / 10%)',
  bandWashStrong: 'rgb(255 255 255 / 22%)',
  bandEdge: 'rgb(255 255 255 / 25%)',
  rule: '#e2dbc9',
  chip: '#f1ead9',
  selection: '#dfd7c4',
  ansi: {
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
  },
};

/**
 * Night — the same card after dark, which on this board means after the canvas filter.
 *
 * `paper` is not chosen. It is `#faf6ee` put through `invert(93%) hue-rotate(180deg)`, which
 * is what the block underneath is painted as and therefore the only value the overlay can
 * take without the two coming apart. Everything on it is Mocha, lifted where Mocha is too
 * dark to read on it.
 *
 * **The band mirrors, it does not stay.** `band` is the ink here as well, which now means a
 * light strip on a dark card rather than a dark strip on a light one, and it has to: the
 * board behind it is dark too, so a dark band is a card with nothing on it at the zoom the
 * band exists for. The colours *on* the band swap with it — `bandInk` is Mocha's `mantle`, and
 * the washes the controls sit on are black here where they are white there, because what a
 * wash has to lift a control off is the surface it is drawn on rather than the theme.
 *
 * The greys are the awkward ones here too, and in the mirror of the way they are on paper: on
 * this surface "black" is the colour of the card, so `black` and `brightBlack` are both mid
 * lights — `brightBlack` the dimmer of them, since that is the one every tool uses for
 * comments — and `brightWhite` is the brightest, which is what a program means when it asks
 * for it. Mocha's own `black` `#45475a` is 1.8:1 here and its `surface2` 2.5:1, so neither
 * survives the floor; `overlay1` and `overlay0` are what clear it.
 */
const DARK: TerminalPalette = {
  paper: '#1d1912',
  ink: '#cdd6f4',
  inkDim: '#9399b2',
  accent: '#a6e3a1',
  alert: '#f38ba8',
  band: '#cdd6f4',
  bandInk: '#181825',
  bandDim: '#45475a',
  // Black rather than white, because the band it lifts a control off is the light one here.
  bandWash: 'rgb(0 0 0 / 10%)',
  bandWashStrong: 'rgb(0 0 0 / 20%)',
  bandEdge: 'rgb(0 0 0 / 22%)',
  rule: '#45475a',
  chip: '#313244',
  selection: '#45475a',
  ansi: {
    black: '#7f849c',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#a6adc8',
    brightBlack: '#6c7086',
    brightRed: '#f37799',
    brightGreen: '#89d88b',
    brightYellow: '#ebd391',
    brightBlue: '#74a8fc',
    brightMagenta: '#f2aede',
    brightCyan: '#6bd7ca',
    brightWhite: '#cdd6f4',
  },
};

export const TERMINAL_PALETTES: Record<TerminalTheme, TerminalPalette> = {
  light: LIGHT,
  dark: DARK,
};

/** The palette for one theme. Anything the board is not is paper. */
export function terminalPalette(theme: TerminalTheme): TerminalPalette {
  return theme === 'dark' ? DARK : LIGHT;
}

/**
 * The shape's fill and stroke — one literal each, in both themes.
 *
 * Not `terminalPalette(...).paper`, and the difference is the whole of #147: these two are
 * scene data on a filtered canvas, so they are the *light* values in both themes and the dark
 * palette is defined as what they render as. See the note at the top of this file.
 */
export const TERMINAL_PAPER = LIGHT.paper;
export const TERMINAL_INK = LIGHT.ink;

/**
 * The whole theme xterm is opened with, and re-themed to.
 *
 * All twenty-one entries, deliberately. A theme that sets five leaves the other sixteen at
 * xterm's own defaults, which are tuned for a dark background — that is how the yellow, the
 * bright white and the bright cyan ended up at 1.1:1 on paper, which is not a colour anyone
 * chose, it is the colour nobody set.
 *
 * `cursorAccent` is the glyph *under* a block cursor, so it is the surface: the cursor is a
 * stamp of accent with the character punched out of it.
 */
export function terminalXtermTheme(theme: TerminalTheme): Record<string, string> {
  const palette = terminalPalette(theme);
  return {
    background: palette.paper,
    foreground: palette.ink,
    cursor: palette.accent,
    cursorAccent: palette.paper,
    selectionBackground: palette.selection,
    ...palette.ansi,
  };
}

/**
 * The same palette as custom properties, for the half of the frame a stylesheet draws.
 *
 * Written onto the card's own root by `TerminalPanel.tsx` rather than onto `:root`, so a
 * board with two terminal blocks is two independent surfaces and nothing leaks into the
 * canvas around them. That is also why the theme is switched *here* rather than by an
 * `[data-theme]` rule: these arrive as inline styles, and a rule cannot outrank one.
 */
export function terminalCssVars(theme: TerminalTheme): Record<string, string> {
  const palette = terminalPalette(theme);
  return {
    '--terminal-paper': palette.paper,
    '--terminal-ink': palette.ink,
    '--terminal-ink-dim': palette.inkDim,
    '--terminal-accent': palette.accent,
    '--terminal-alert': palette.alert,
    '--terminal-band': palette.band,
    '--terminal-band-ink': palette.bandInk,
    '--terminal-band-dim': palette.bandDim,
    '--terminal-band-wash': palette.bandWash,
    '--terminal-band-wash-strong': palette.bandWashStrong,
    '--terminal-band-edge': palette.bandEdge,
    '--terminal-rule': palette.rule,
    '--terminal-chip': palette.chip,
    '--terminal-selection': palette.selection,
  };
}
