/**
 * Every setting this browser remembers, and the one door they are read and written through.
 *
 * Eight things live in `localStorage`: the theme, whether Excalidraw's own menus are hidden,
 * which project was last open, the terminal's font size, the terminal's rect per board, how
 * far the documentation has been pushed per board, each board's camera, and which rows of a
 * folded transcript the reader has opened. They accumulated one at a time, each spelled at
 * the point it was read — and the theme was not even spelled as a constant, but as the same
 * literal written out twice, one read and one write, six thousand lines apart.
 *
 * That is a set nobody could enumerate, which made it a set nobody could rename safely. A
 * pass that caught the six named constants missed the theme; a pass that caught all eight
 * would have reset every one of these settings on the first load after the upgrade, and
 * reset them *silently*, because an absent key and a reader who never chose anything are the
 * same thing to every one of these call sites. The set is now here, and a rename is a change
 * to `current` alone.
 *
 * **The legacy name is kept beside the current one rather than deleted.** It is what every
 * profile out there is still holding, and it is the only reason the rename below cost nobody
 * their theme. Keeping it also documents the names in one place instead of in a migration
 * that ran once and was then removed, which is the form this shim would otherwise decay into.
 */
export interface StorageKey {
  /** The name written to, and read from first. */
  current: string
  /** The name a profile from before the rename is holding. Read only as a fallback. */
  legacy: string
}

/** The settings this browser remembers. One entry per key; there are no others. */
export type StorageSetting =
  | 'theme'
  | 'chrome'
  | 'workspace'
  | 'terminalFont'
  | 'terminalGeometry'
  | 'documentationShift'
  | 'boardViewports'
  | 'terminalFolds'

/**
 * Both names of every setting.
 *
 * The current names carry the product's own, which is what `rename-brand-05` was about: they
 * were `excalidraw-*` because the board began as a wrapper around Excalidraw, and a reader
 * who opens their developer tools on VibeMaxxing should not find another product's prefix
 * there. Nothing user-visible depends on either name — which is exactly why the rename was
 * free to make *once the fallback existed*, and would have been a silent reset without it.
 *
 * `terminalFolds` is a **prefix** rather than a key: the folds are per session, and the
 * session's id is appended by the caller. `readSetting` takes that suffix so the pair is
 * still the one thing being named.
 */
export const STORAGE_KEYS: Record<StorageSetting, StorageKey> = {
  theme: { current: 'vibemaxxing-canvas-theme', legacy: 'excalidraw-canvas-theme' },
  chrome: { current: 'vibemaxxing-canvas-chrome', legacy: 'excalidraw-canvas-chrome' },
  workspace: { current: 'vibemaxxing-canvas-workspace', legacy: 'excalidraw-canvas-workspace' },
  terminalFont: { current: 'vibemaxxing-terminal-font-size', legacy: 'excalidraw-terminal-font-size' },
  terminalGeometry: { current: 'vibemaxxing-terminal-geometry', legacy: 'excalidraw-terminal-geometry' },
  documentationShift: { current: 'vibemaxxing-documentation-shift', legacy: 'excalidraw-documentation-shift' },
  boardViewports: { current: 'vibemaxxing-board-viewports', legacy: 'excalidraw-board-viewports' },
  terminalFolds: { current: 'vibemaxxing.terminal.folds', legacy: 'excalidraw.terminal.folds' },
}

/**
 * What a setting is worth, taking the old name as the answer when the new one has none.
 *
 * The value is written forward on that first read, so the fallback is paid once per profile
 * rather than on every load — and so a second tab, or a second setting read later in the same
 * page, finds the current name already populated.
 *
 * **The legacy key is left where it is.** Deleting it would buy a tidier profile and cost the
 * one thing worth having here: a reader who goes back to an older build still finds their
 * theme. Nothing else reads these names, so a stale key costs a few bytes and no correctness.
 *
 * Storage exceptions are **not** caught here. Every caller already sits inside a `try` that
 * warns and falls back to its own default — some of them have to, because they parse what
 * comes back — and swallowing here would leave those blocks unreachable while changing what a
 * private-mode browser sees. What is caught is the forward *write*: a profile that cannot be
 * written to should still be readable, and losing the migration is not a reason to lose the
 * value it just found.
 */
export function readSetting(key: StorageKey, suffix = ''): string | null {
  const store = window.localStorage
  if (!store) return null
  const current = `${key.current}${suffix}`
  const held = store.getItem(current)
  if (held !== null) return held
  const legacy = `${key.legacy}${suffix}`
  if (legacy === current) return null
  const carried = store.getItem(legacy)
  if (carried === null) return null
  try {
    store.setItem(current, carried)
  } catch { /* private mode, or the quota. The value still stands for this page. */ }
  return carried
}

/** Write a setting down, under the current name only. */
export function writeSetting(key: StorageKey, value: string, suffix = ''): void {
  window.localStorage?.setItem(`${key.current}${suffix}`, value)
}
