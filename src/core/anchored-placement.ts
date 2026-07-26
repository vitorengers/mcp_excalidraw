/**
 * Where to put a card that belongs to a shape on the canvas.
 *
 * Pure arithmetic on rectangles, deliberately kept out of the component that renders the
 * card. Placement is the part with edge cases — a block against the right edge, a block
 * taller than the viewport, a card that fits nowhere — and it is the part worth testing.
 * A component that also does the arithmetic can only be tested by driving a browser, and
 * this project has no browser test yet.
 *
 * Everything here is in **viewport coordinates**, relative to the canvas area's top-left.
 * Converting scene coordinates to those is Excalidraw's job (`sceneCoordsToViewportCoords`).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Which side of the anchor the card ended up on. */
export type Side = 'right' | 'left' | 'below' | 'above';

export interface Placement {
  left: number;
  top: number;
  side: Side;
  /**
   * True when no side had room and the card was forced inside the viewport, so it
   * probably overlaps the shape it belongs to. The caller may want to say so.
   */
  clamped: boolean;
}

export interface PlacementOptions {
  /** Distance between the shape and the card, in screen pixels. */
  gap?: number;
  /** Smallest distance the card keeps from the edge of the canvas area. */
  margin?: number;
}

export const DEFAULT_GAP = 16;
export const DEFAULT_MARGIN = 12;

/** Keep `value` within [min, max], preferring `min` when the range is inverted. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Place `card` next to `anchor` inside `viewport`.
 *
 * Sides are tried right, left, below, above — right first because reading order puts a
 * card there in the least surprising place, and because the sidebar this replaces was on
 * the right. The first side with room wins.
 *
 * On the horizontal sides the card is aligned with the top of the shape and slid
 * vertically to stay on screen; on the vertical sides, the other way round. Sliding is
 * not "clamped": the card is still beside the shape it belongs to. `clamped` is reserved
 * for the case where no side had room at all.
 */
export function placeCard(
  anchor: Rect,
  card: Size,
  viewport: Size,
  options: PlacementOptions = {}
): Placement {
  const gap = options.gap ?? DEFAULT_GAP;
  const margin = options.margin ?? DEFAULT_MARGIN;

  const maxLeft = viewport.width - margin - card.width;
  const maxTop = viewport.height - margin - card.height;

  // Aligned with the shape, then slid back on screen.
  const alignedTop = clamp(anchor.y, margin, maxTop);
  const alignedLeft = clamp(anchor.x, margin, maxLeft);

  const right = anchor.x + anchor.width + gap;
  if (right <= maxLeft) {
    return { left: right, top: alignedTop, side: 'right', clamped: false };
  }

  const left = anchor.x - gap - card.width;
  if (left >= margin) {
    return { left, top: alignedTop, side: 'left', clamped: false };
  }

  const below = anchor.y + anchor.height + gap;
  if (below <= maxTop) {
    return { left: alignedLeft, top: below, side: 'below', clamped: false };
  }

  const above = anchor.y - gap - card.height;
  if (above >= margin) {
    return { left: alignedLeft, top: above, side: 'above', clamped: false };
  }

  // Nowhere to go — a shape filling the screen, or a viewport smaller than the card.
  // Keep the card on screen and accept that it covers part of the shape: a card that
  // hangs off the edge is unreadable, one that overlaps is merely in the way.
  return {
    left: clamp(right, margin, maxLeft),
    top: alignedTop,
    side: 'right',
    clamped: true,
  };
}

/**
 * How tall the card may be here.
 *
 * Placement is computed from this rather than from what the card actually renders,
 * which keeps it a function of numbers known before the first paint — no measure,
 * re-place, re-measure loop. A card shorter than its maximum simply sits a little
 * higher than it strictly needs to.
 */
export function cardHeightFor(viewport: Size, maxHeight: number, margin = DEFAULT_MARGIN): number {
  return Math.max(0, Math.min(maxHeight, viewport.height - margin * 2));
}
