/**
 * Lays a label out inside its container, well enough that nothing hangs outside it.
 *
 * The browser is the only thing here that can truly measure text, and this file does not
 * pretend otherwise. It exists because the alternative was worse: writing a label without
 * laying it out at all put a 518px title inside a 400px block, on one line, in a box still
 * sized for the observation that started the run.
 *
 * The estimate is deliberately **generous** — it over-states how wide a character is. An
 * over-estimate wraps a line earlier than strictly needed, which looks slightly loose; an
 * under-estimate puts text outside the box, which is the bug. Failing towards loose is the
 * whole point. Excalidraw re-measures the text on load and tightens it, so the wrap this
 * produces is a ceiling rather than the final geometry.
 */

/** Excalidraw's own padding between a container and the text bound to it. */
export const BOUND_TEXT_PADDING = 5;

/**
 * Character advance as a fraction of font size.
 *
 * Measured against the real thing: the browser laid out a 64-character title at font size
 * 16 in 518px, i.e. 0.506. Rounded up to 0.55 so the estimate errs towards wrapping early.
 */
const ADVANCE = 0.55;

export interface LabelLayout {
  /** The text with line breaks inserted where it has to wrap. */
  text: string;
  width: number;
  height: number;
  /** Height the container needs to hold the text with padding on both sides. */
  containerHeight: number;
  lines: string[];
}

const widthOf = (line: string, fontSize: number): number => Math.ceil(line.length * fontSize * ADVANCE);

/** Split one over-long word so it cannot stick out of the box on its own. */
function breakWord(word: string, maxChars: number): string[] {
  const pieces: string[] = [];
  for (let index = 0; index < word.length; index += maxChars) {
    pieces.push(word.slice(index, index + maxChars));
  }
  return pieces;
}

export function wrap(text: string, maxWidth: number, fontSize: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * ADVANCE)));
  const lines: string[] = [];

  // Existing line breaks are the author's, and are kept; each is wrapped on its own.
  for (const paragraph of text.split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const pieces = word.length > maxChars ? breakWord(word, maxChars) : [word];
      for (const piece of pieces) {
        const candidate = current ? `${current} ${piece}` : piece;
        if (candidate.length <= maxChars) {
          current = candidate;
        } else {
          if (current) lines.push(current);
          current = piece;
        }
      }
    }
    lines.push(current);
  }

  return lines.length ? lines : [''];
}

/**
 * Lay `text` out for a container of `containerWidth`.
 *
 * `containerHeight` is what the container should become — the caller decides whether to
 * apply it, since a container may have a reason to stay larger.
 */
export function layoutLabel(
  text: string,
  containerWidth: number,
  fontSize: number,
  lineHeight = 1.25
): LabelLayout {
  const maxWidth = Math.max(fontSize, containerWidth - BOUND_TEXT_PADDING * 2);
  const lines = wrap(text, maxWidth, fontSize);
  const height = Math.ceil(lines.length * fontSize * lineHeight);

  return {
    text: lines.join('\n'),
    width: Math.min(maxWidth, Math.max(...lines.map((line) => widthOf(line, fontSize)))),
    height,
    containerHeight: height + BOUND_TEXT_PADDING * 2,
    lines,
  };
}
