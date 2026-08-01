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
 *
 * ## Ink is half the question, and the other half is what a slot is a page for
 *
 * That floor asks each of the sixteen to be legible **on the surface**. A program that draws a
 * chip asks something else of them: it picks one as a *background* and inks it with another,
 * and no pair was ever checked. Claude Code — the program this block exists to run — draws its
 * hint as ANSI `black` on ANSI `brightCyan`, which was **1.11:1** on paper and 2.15:1 on night,
 * the illegible strip in #147's screenshot. That is #159, and the contract it settles is:
 *
 * - **`black` is the ink**, and it is the end of the ramp rather than a grey in the middle of
 *   one. On paper that means the darkest colour the palette has; on night it means the slot
 *   *closest to the surface* that still clears the ink floor, because a black below the floor
 *   fails the other check.
 * - **A pair clears the same 3:1** the ink does. On paper `black` can go all the way out, so
 *   fourteen of the other fifteen are pages under it; only `brightWhite` is not, and cannot be,
 *   since on paper it is the strongest grey ink and `black` on it is ink on ink.
 * - **On night the ink floor holds `black` up**, so a page has to be about **ten times** the
 *   surface to clear 3:1 over it. That is the light half of Mocha: `yellow`, `green`, `cyan`
 *   and `magenta` in both their members, plus `brightWhite`. `red`, `blue`, `white`,
 *   `brightRed`, `brightBlue` and `brightBlack` are **out of reach**, and the reason is the hue
 *   rather than the taste — a red or a blue lifted to a 10:1 ink is a pink or a powder blue,
 *   which is no longer that colour.
 * - **`brightWhite` is the other ink, on night only.** On paper there is no light ink at all
 *   and there cannot be: every one of the sixteen is 3:1 ink on a light page, so every one of
 *   them is dark. A program that draws light-on-colour cannot be served by any palette that
 *   keeps the ink floor. That is a cost of the floor, written down rather than hidden.
 *
 * `scripts/check-terminal-pairs-browser.mjs` prints all sixteen as pages from a real shell and
 * reads both colours back off the render, in both themes, and it asserts the lists above
 * **exactly** — a slot that quietly comes into reach fails it too, because the same lists are
 * in `docs/terminal.md` and a list that is true in one place only is how this file drifted
 * before.
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
 * nothing. The **white end** of the ramp is therefore read as *contrast* rather than as
 * lightness: `white` is a mid ink, `brightBlack` is the dim one every tool uses for comments
 * and secondary text, and `brightWhite` is the strongest of those three, which is what a
 * program means when it asks for it.
 *
 * **The black end is not inverted, and #159 is what inverting it cost.** Turning a colour round
 * is what you do when its own meaning is unavailable, and "white" on paper is unavailable.
 * "Black" is not: it is the darkest ink there is, which is exactly what the word means, and it
 * is the one slot a program reaches for when it draws *on* a colour. It was `#5c5f77` — a mid
 * grey, picked for symmetry with `white` — and that symmetry is the whole of why every pair
 * from within the sixteen was illegible: a chip inked from the middle of the ramp has nothing
 * under it to be read against. It is Mocha's `crust` now, the darkest colour Catppuccin has,
 * borrowed from the other side of the family exactly as the dark palette's surface is this
 * one's paper after the filter. Latte has no near-black of its own; its darkest is `text`
 * `#4c4f69`, which is already `brightWhite` here.
 *
 * The cost that remains is that `white` and `brightBlack` are two similar greys, so a program
 * that distinguishes those two will not be distinguished here. That is inherent to printing
 * sixteen colours on paper and is written down in `docs/terminal.md` rather than hidden.
 *
 * "Bright" is otherwise more ink rather than more light: a bright colour is the darker, more
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
    // Mocha's `crust`. The ink a chip is drawn with, and therefore the far end of the ramp.
    black: '#11111b',
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
 * survives the floor.
 *
 * **`black` sits as close to that floor as ink can**, and #159 is why the number matters. It
 * was `overlay1` `#7f849c`, comfortably clear at 4.7:1, and every chip drawn on this card paid
 * for the comfort: the higher `black` is, the fewer slots are far enough above it to be a page
 * under it. `#666a81` is between Mocha's `surface2` and `overlay0` and clears the floor at
 * 3.3:1, which is what puts the light half of the palette in reach as pages. It cannot go
 * lower — the ink floor is the other check — and that ceiling is what makes `red`, `blue` and
 * their bright members out of reach for good. See the contract at the top of this file.
 *
 * **"Bright" means further from the surface here, which on a dark card means lighter**, and the
 * six chromatic pairs were the wrong way round: `brightCyan` was `#6bd7ca` against a `cyan` of
 * `#94e2d5`, the light palette's rule — bright is the darker, more saturated member — applied
 * to a surface it is backwards on. Emphasis was reading as *less* emphasis, and the dimmer
 * member of each pair was the one a program picks for a chip's page, which is how the worst
 * pair on this card came to be `bgCyanBright`. The six pairs are swapped rather than
 * re-invented: not one hex changed, they are simply the way round the ramp already claimed to
 * be, and `white`/`brightWhite` always were. `brightBlack` stays the exception it was — the
 * comment grey is dimmer than `black` by trade, everywhere.
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
    // As near the ink floor as a slot can be, so that as much of the palette as possible is
    // far enough above it to be a page. See the note above.
    black: '#666a81',
    red: '#f37799',
    green: '#89d88b',
    yellow: '#ebd391',
    blue: '#74a8fc',
    magenta: '#f2aede',
    cyan: '#6bd7ca',
    white: '#a6adc8',
    brightBlack: '#6c7086',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
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
 * ## Writing in one of the sixteen, rather than in a colour
 *
 * Everything above answers "what is slot N painted as". What follows answers the other
 * direction: a program on this surface wants to *say* something — this line is a file being
 * read, that one is a tool that failed — and the only spelling of that which survives a theme
 * toggle is the slot number. `\u001b[36m` is resolved by whichever palette the reader is in;
 * `\u001b[38;2;14;124;134m` is the light palette's cyan printed into a dark card, where it was
 * never checked and does not clear the floor. So the escapes below are **SGR 30-37 and 90-97
 * only**, and that single restriction is what makes both themes fall out of one map rather
 * than be maintained twice.
 *
 * Nothing here writes bold or dim either, and both are deliberate. `drawBoldTextInBrightColors`
 * is xterm's default and is not turned off, so **bold plus a colour is not an independent axis**
 * — it is the bright member of the same pair, and on the dark palette those pairs were swapped
 * in #159, so bold would mean "lighter" on one card and "darker" on the other. **Dim** is worse:
 * xterm draws it by blending the glyph toward the background, which is exactly the 3:1 floor
 * every one of the sixteen was moved to clear, halved. The palette already owns a dim ink that
 * clears it — `brightBlack`, the comment grey in both themes — so "dim" here means that slot.
 */

/** One of the sixteen, by the name `TerminalAnsi` gives it. */
export type TerminalSlot = keyof TerminalAnsi;

/**
 * ## The seventeenth ink, and the one view it exists in
 *
 * Everything above is the rule the paragraph before it states: colour is the sixteen slots,
 * because the transcript is composed on the **server**, which cannot know which of the two
 * palettes the reader is in. #258 asked for Claude's orange on the marker that says the agent is
 * thinking, and orange is not one of the sixteen — `yellow` is already `mutation` and `red` is
 * already `failure`, so there is no slot to borrow either.
 *
 * The exception is possible because #251 moved one reader off the emulator. A transcript the
 * board composed is drawn as a *document*: `parseFoldedTranscript` reads a line back into slot
 * **names**, and `TerminalPanel.tsx` resolves a name to a hex at paint time, which is the first
 * point in the chain that knows the theme. A name is exactly what a theme toggle can resolve
 * twice, so an ink that is not one of the sixteen can exist there with a hex per theme, checked
 * on each of the two surfaces, without printing either hex into the other card.
 *
 * **And it stops there.** It cannot be written as SGR — there is no number for it — so it
 * travels as a mark on #251's private OSC, which an emulator draws as nothing. In an emulator
 * the marked run therefore comes out on the default ink: correct, dimmer than intended, and
 * never wrong in a theme. Nothing else is allowed to follow it. The rule for every byte that may
 * reach xterm is unchanged, and this exception is written down in `docs/terminal.md` with the
 * same boundary on it.
 */
export type TerminalDocumentInk = 'agent';

/** A name the fold view can paint with: one of the sixteen, or the seventeenth. */
export type TerminalInk = TerminalSlot | TerminalDocumentInk;

/**
 * The inks that live outside the sixteen, one hex per theme.
 *
 * `agent` is the agent's own mark — the `✻` starburst and the word beside it — and both values
 * are Anthropic's brand orange `#d97757`, which is what the ask names. Only the night one is
 * that hex: on paper `#d97757` is **2.9:1**, under the 3:1 floor every other ink on this card
 * was moved to clear, so the light value is the same hue and saturation taken down until it
 * clears — 3.63:1, the ratio `yellow` already sits at there. One orange cannot serve both
 * surfaces, which is the whole reason this is a named ink rather than a substitution.
 *
 * The name is the agent rather than the vendor on purpose: nothing in this repository requires
 * the configured command to be Claude Code, and what the ink means is "this line is the agent
 * itself, not its work". The hex is the brand's because the marker is.
 */
export const DOCUMENT_INKS: Record<TerminalDocumentInk, Record<TerminalTheme, string>> = {
  agent: { light: '#d25d37', dark: '#d97757' },
};

/**
 * Every ink the fold view can be handed a name for, for one theme.
 *
 * The sixteen and the seventeenth in one table, because `paint` looks a segment's name up in
 * one place and a second table would be a second thing to keep in step with the theme.
 */
export function terminalDocumentInk(theme: TerminalTheme): Record<string, string> {
  const inks: Record<string, string> = { ...terminalPalette(theme).ansi };
  for (const [name, perTheme] of Object.entries(DOCUMENT_INKS)) inks[name] = perTheme[theme];
  return inks;
}

/** The number a program spells a slot with as a foreground: 30-37, then 90-97. */
const SLOT_SGR: Record<TerminalSlot, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  brightBlack: 90, brightRed: 91, brightGreen: 92, brightYellow: 93,
  brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97,
};

/** Back to whatever the reader's palette calls the default. */
export const ANSI_RESET = '\u001b[0m';

/** Turning one of the sixteen on, without turning it off again. */
export function slotEscape(slot: TerminalSlot): string {
  return `\u001b[${SLOT_SGR[slot]}m`;
}

/**
 * One run of text in one slot, closed.
 *
 * Closed rather than left open on purpose: a transcript is appended to for the life of a run,
 * and a sequence that is never reset paints every line after it — which is how a tool's own
 * stray colour used to be the only colour in the block.
 */
export function inSlot(slot: TerminalSlot, text: string): string {
  return text ? `${slotEscape(slot)}${text}${ANSI_RESET}` : text;
}

/**
 * What kind of thing an agent's tool call *is*.
 *
 * A category rather than a list of tools, because the names arrive from the agent's stream and
 * the set is open: an MCP server contributes tools nobody here has heard of, spelled
 * `mcp__server__tool`. A colour per name would be a table that is wrong the first time somebody
 * connects a server; a colour per kind is a rule that answers for names it has never seen.
 *
 * The kinds are the ones a reader watching a run is actually telling apart — is it *looking*,
 * is it *changing something*, is it *running something*, is it *going out to the network*, is
 * it *handing the work to something else* — and `other` is the honest answer for everything
 * else, which is why it is the ink rather than a sixth hue. Colour here is added information,
 * and inventing a category for a tool we cannot place would be adding the wrong information.
 */
export type AgentAction = 'inspection' | 'mutation' | 'execution' | 'network' | 'delegation' | 'other';

/**
 * A kind, and the slot it is drawn in.
 *
 * Five hues and the ink. `green` is also what a finished run closes in, and that is a
 * coincidence worth keeping rather than designing away: a `Bash` line and a `the run finished`
 * line are both "something ran", and the block reads as one thing.
 */
export const AGENT_ACTION_SLOT: Record<AgentAction, TerminalSlot> = {
  inspection: 'cyan',
  mutation: 'yellow',
  execution: 'green',
  network: 'blue',
  delegation: 'magenta',
  other: 'brightWhite',
};

/**
 * The rest of a transcript's vocabulary, which is not a tool call.
 *
 * `argument` and `aside` are the same dim ink for the same reason — both are beside the point
 * of the line they are on — and they are named apart because they are two decisions and only
 * one of them is likely to be revisited. `aside` was the third of them until #258: the thinking
 * marker left it, and the two that stayed are the two that really are beside the point.
 */
export const AGENT_INK = {
  /** What is inside the parens: the path, the command, the query. */
  argument: 'brightBlack',
  /** The gutter, the continuation indent, the `… N more lines` tail. */
  aside: 'brightBlack',
  /**
   * The agent's own mark, which is the `✻ thinking…` line and nothing else yet.
   *
   * The seventeenth ink, so it exists only where a name is resolved at paint time — see
   * `TerminalDocumentInk` above. Deliberately *not* the `⏺` bullets: those carry #242's five
   * categories, and painting them all one colour would take that information away to add this
   * one. Deliberately not the closing line either, which is `green` or `red` and says whether
   * the run worked.
   */
  presence: 'agent',
  /** A run that finished. */
  success: 'green',
  /** A run that reported an error, and a tool result carrying `is_error`. */
  failure: 'red',
} as const satisfies Record<string, TerminalInk>;

/**
 * The tools each kind is spelled with — the ones this board's agents actually call.
 *
 * Deliberately short. Anything not here is `other`, and a name that turns out to matter is one
 * line to add; a list that tries to be exhaustive is a list that goes stale silently.
 */
const ACTION_TOOLS: Record<Exclude<AgentAction, 'other'>, readonly string[]> = {
  inspection: ['read', 'glob', 'grep', 'ls', 'notebookread', 'todoread'],
  mutation: ['write', 'edit', 'multiedit', 'notebookedit', 'todowrite'],
  execution: ['bash', 'powershell', 'bashoutput', 'killbash', 'killshell'],
  network: ['webfetch', 'websearch'],
  delegation: ['agent', 'task', 'skill', 'workflow'],
};

/**
 * What kind of thing a tool is, by its name.
 *
 * An `mcp__…` tool is `delegation`: whatever it does, it is another program doing it, which is
 * the same thing a sub-agent is from the point of view of somebody watching this run. It is
 * also the one open-ended shape in the stream, so leaving it to `other` would have left the
 * commonest unrecognised name uncoloured.
 */
export function agentAction(toolName: string): AgentAction {
  const name = toolName.trim().toLowerCase();
  if (name.startsWith('mcp__')) return 'delegation';
  for (const [action, tools] of Object.entries(ACTION_TOOLS)) {
    if (tools.includes(name)) return action as AgentAction;
  }
  return 'other';
}

// There was an `agentToolSlot(name)` here, which is where the two halves above used to be joined.
// It had one call site, and that call site is now `AGENT_ACTION_SLOT[step.action]` in
// `agent-stream-render.ts`: a step arrives already carrying its kind, because *which* kind a name
// is is the backend's answer — `command_execution` is Codex's word for what Claude Code calls
// `Bash` — while what colour a kind is drawn in is this file's, and is the same for both.

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
