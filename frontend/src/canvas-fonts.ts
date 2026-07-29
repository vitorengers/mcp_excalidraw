/**
 * When the canvas fonts have actually arrived — and why anything has to wait for them.
 *
 * Excalidraw does not keep the `width` a text element was authored with. Everything this app
 * puts on the canvas goes through `convertToExcalidrawElements`, whose `text` branch calls
 * `newTextElement`, and that throws the incoming width away and re-measures the string with a
 * `CanvasRenderingContext2D` — in whatever font the browser has *at that instant*. On a cold
 * profile that instant is before any webfont has arrived, so the number recorded is the
 * fallback font's, which is narrower. When Excalifont lands, `Fonts.onLoaded` invalidates the
 * shape cache and repaints, but it never re-measures: the glyphs are now wider than the width
 * the element is clipped to, and the tail of every label is cut. Nothing later fixes it —
 * these are authored elements and nothing redraws them (#234).
 *
 * So the scene waits for its fonts instead. Waiting is cheap because it is per family and per
 * character: only the `woff2` subsets the incoming text actually needs are asked for, and the
 * board's own server answers them (see `EXCALIDRAW_ASSET_PATH` in `frontend/index.html`).
 *
 * **`document.fonts.check` cannot be what it waits on.** For a family nothing has registered it
 * answers `true` — the system font substituted for it is by definition already loaded — so on
 * the one load where the answer matters, before Excalidraw has added its `FontFace`s, it says
 * yes to every font in the world. What is used here instead is the `FontFace` objects
 * themselves, plus a measurement: a family that is being substituted measures exactly the same
 * as a family that does not exist, and a real load moves that number.
 */

/**
 * Excalidraw's `FONT_FAMILY`, by the number a text element stores.
 *
 * Helvetica (2) is deliberately absent: Excalidraw marks it `local` and registers no
 * downloadable face for it, so there would be nothing to wait for and the wait would spend its
 * whole budget finding that out.
 */
const FAMILY_NAMES: Record<number, string> = {
  1: 'Virgil',
  3: 'Cascadia',
  5: 'Excalifont',
  6: 'Nunito',
  7: 'Lilita One',
  8: 'Comic Shanns',
  9: 'Liberation Sans',
}

/**
 * How long a family is waited for before the board is drawn without it.
 *
 * A ceiling rather than a timeout anybody expects to hit: the fonts are served by the board's
 * own server, so reaching this means the install is broken or the file is gone. A label a
 * character short is worth having; a canvas that never appears is not. Comfortably above what
 * a local fetch costs, and above the 2.5 s `check-canvas-fonts-browser.mjs` holds one back by.
 */
const WAIT_CAP_MS = 6000

/** A string long enough that no two different fonts measure it identically. */
const PROBE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A family name nothing will ever register, so it always measures as the substitute. */
const ABSENT_FAMILY = '__excalidraw-canvas-absent__'

/** Anything with text on it, from the socket or from `GET /api/elements`. */
export interface MeasurableText {
  type?: string
  fontFamily?: number
  text?: string
  originalText?: string
}

/** Characters proven loadable for a family, so the same wait is not paid twice. */
const settled = new Map<string, Set<string>>()

/** One wait at a time per family: two messages must not both decide it is unregistered. */
const chain = new Map<string, Promise<void>>()

let probeContext: CanvasRenderingContext2D | null = null

const measure = (text: string, font: string): number => {
  if (!probeContext) probeContext = document.createElement('canvas').getContext('2d')
  if (!probeContext) return 0
  probeContext.font = font
  return probeContext.measureText(text).width
}

/** Whether the browser is drawing something else under this family's name. */
const isSubstituted = (family: string): boolean =>
  Math.abs(measure(PROBE, `16px "${family}"`) - measure(PROBE, `16px "${ABSENT_FAMILY}"`)) < 0.01

/** The faces Excalidraw has registered for a family, if it has got that far. */
const facesFor = (family: string): FontFace[] => {
  const faces: FontFace[] = []
  document.fonts.forEach((face) => { if (face.family === family) faces.push(face) })
  return faces
}

const nextFrame = (): Promise<void> => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
  else setTimeout(resolve, 16)
})

const waitUntil = async (condition: () => boolean, deadline: number): Promise<boolean> => {
  while (!condition()) {
    if (Date.now() >= deadline) return false
    await nextFrame()
  }
  return true
}

const settleFamily = async (family: string, characters: string): Promise<void> => {
  const known = settled.get(family) ?? new Set<string>()
  const missing = Array.from(characters).filter((character) => !known.has(character)).join('')
  if (!missing) return

  const deadline = Date.now() + WAIT_CAP_MS
  let complained = ''

  // Registered first. `document.fonts.load` for a family nothing declares resolves at once
  // with an empty list, and the substitute already in place — which is the same lie
  // `fonts.check` tells, one call further along.
  if (!await waitUntil(() => facesFor(family).length > 0, deadline)) {
    complained = 'Excalidraw never registered it'
  }

  // Exactly the subsets these characters need. Excalifont alone is split across seven files by
  // `unicodeRange`, so a wait that loaded the ASCII one would still measure `Especificação`
  // against the fallback.
  let faces: FontFace[] = []
  if (!complained) {
    try {
      faces = await document.fonts.load(`16px "${family}"`, missing)
    } catch (error) {
      complained = String(error)
    }
  }

  // No face covering these characters is not a failure — an emoji in an Excalifont label has
  // none, and there is nothing to wait for. A face that was matched has to finish.
  if (!complained && faces.length > 0
      && !await waitUntil(() => faces.every((face) => face.status === 'loaded'), deadline)) {
    complained = 'the face never finished loading'
  }

  // And the measurement, which is the half a status cannot give: a family whose faces all say
  // `loaded` still measures as the substitute if the browser is drawing something else.
  if (!complained && !await waitUntil(() => !isSubstituted(family), deadline)) {
    complained = 'it still measures as a substitute'
  }

  // Recorded either way, so a font that cannot arrive costs this wait once rather than on
  // every message for the life of the tab.
  for (const character of characters) known.add(character)
  settled.set(family, known)
  if (complained) {
    console.warn(`Canvas font "${family}" was not ready in time — ${complained}. `
                 + 'Labels in it may be measured against the fallback font.')
  }
}

/** The characters each canvas family has to be able to draw for these elements. */
const charactersByFamily = (elements: readonly MeasurableText[]): Map<string, string> => {
  const perFamily = new Map<string, Set<string>>()
  for (const element of elements) {
    if (element?.type !== 'text') continue
    const family = FAMILY_NAMES[element.fontFamily ?? 5]
    if (!family) continue
    const text = element.originalText ?? element.text ?? ''
    let characters = perFamily.get(family)
    if (!characters) { characters = new Set<string>(); perFamily.set(family, characters) }
    for (const character of text) characters.add(character)
  }
  return new Map(
    Array.from(perFamily, ([family, characters]) => [family, Array.from(characters).join('')])
  )
}

/**
 * Hold until every canvas font these elements are written in can be measured.
 *
 * Resolves immediately once a family's characters have been settled, so this sits in front of
 * every message without costing anything after the first board has landed.
 */
export const canvasFontsReady = async (
  elements: readonly MeasurableText[] | null | undefined
): Promise<void> => {
  if (!elements || elements.length === 0) return
  if (typeof document === 'undefined' || !document.fonts) return

  const wanted = charactersByFamily(elements)
  await Promise.all(Array.from(wanted, ([family, characters]) => {
    const previous = chain.get(family) ?? Promise.resolve()
    const next = previous.then(() => settleFamily(family, characters))
    chain.set(family, next)
    return next
  }))
}
