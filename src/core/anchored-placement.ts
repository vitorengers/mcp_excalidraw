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
  /**
   * Other overlays already on screen, in the same viewport coordinates.
   *
   * The viewport is not empty. The terminal panels are DOM overlays on the same layer as
   * the card and later in the DOM, so where both want the same pixels the terminal takes
   * them and the card is covered rather than moved (#241). A side is only chosen when it
   * has viewport room *and* is clear of all of these; with none clear the card falls back
   * to what it would have done anyway, because a card over a terminal beats a card off
   * the edge.
   *
   * An obstacle that is the anchor's own overlay is ignored — a terminal block must not
   * push its own documentation around.
   */
  obstacles?: Rect[];
}

export const DEFAULT_GAP = 16;
export const DEFAULT_MARGIN = 12;

/** Keep `value` within [min, max], preferring `min` when the range is inverted. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** Do two rectangles share any pixel? Touching edges do not count. */
function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Where a placement puts the card, as a rectangle. */
function rectOf(placement: Placement, card: Size): Rect {
  return { x: placement.left, y: placement.top, width: card.width, height: card.height };
}

/**
 * Is `inner` the anchor's own overlay?
 *
 * A terminal panel covers its block's bounds exactly, so the block's own panel arrives as an
 * obstacle sitting on the anchor. The tolerance is for the sub-pixel arithmetic of
 * `sceneCoordsToViewportCoords`, not for a second overlay that merely starts inside the shape.
 */
function isAnchorItself(anchor: Rect, inner: Rect, tolerance = 1): boolean {
  return (
    inner.x >= anchor.x - tolerance &&
    inner.y >= anchor.y - tolerance &&
    inner.x + inner.width <= anchor.x + anchor.width + tolerance &&
    inner.y + inner.height <= anchor.y + anchor.height + tolerance
  );
}

/**
 * The same placement, moved along its own free axis until it is clear of every obstacle.
 *
 * A card beside a shape may slide up and down without stopping being beside it; a card
 * below one may slide left and right. That is the sliding the module already does to stay
 * on screen, and this is the same movement for the other reason.
 *
 * The positions worth trying are the ones flush against an obstacle — just before it, just
 * after it — because a card that clears an obstacle at all clears it at one of those or at
 * a position further away, and the nearest to where the card wanted to be is the one that
 * moves it least. Each is put back on screen before it is tried, and tried against every
 * obstacle rather than the one it was derived from. Null when nothing on that axis works.
 */
function slideClear(
  placement: Placement,
  card: Size,
  obstacles: Rect[],
  margin: number,
  maxLeft: number,
  maxTop: number
): Placement | null {
  const horizontal = placement.side === 'below' || placement.side === 'above';
  const max = horizontal ? maxLeft : maxTop;
  if (max < margin) return null;

  const wanted = horizontal ? placement.left : placement.top;
  const span = horizontal ? card.width : card.height;
  const candidates = obstacles
    .flatMap((rect) => {
      const start = horizontal ? rect.x : rect.y;
      const size = horizontal ? rect.width : rect.height;
      return [start - span, start + size];
    })
    .map((value) => clamp(value, margin, max))
    .sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));

  for (const value of candidates) {
    const moved: Placement = horizontal
      ? { ...placement, left: value }
      : { ...placement, top: value };
    if (obstacles.every((rect) => !intersects(rectOf(moved, card), rect))) return moved;
  }
  return null;
}

/**
 * Place `card` next to `anchor` inside `viewport`.
 *
 * Sides are tried right, left, below, above — right first because reading order puts a
 * card there in the least surprising place, and because the sidebar this replaces was on
 * the right. The first side with room, and clear of `options.obstacles`, wins; with no
 * clear side the first side with room wins as it always did.
 *
 * On the horizontal sides the card is aligned with the top of the shape and slid
 * vertically to stay on screen; on the vertical sides, the other way round. That same
 * slide is the second thing tried against an obstacle: with no side clear where the card
 * is aligned, each side in turn is slid along the axis it already slides on until it is
 * clear, still on screen and still on that side of the shape. Sliding is not "clamped":
 * the card is still beside the shape it belongs to. `clamped` is reserved for the case
 * where no side had room at all — an obstacle never sets it.
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
  const left = anchor.x - gap - card.width;
  const below = anchor.y + anchor.height + gap;
  const above = anchor.y - gap - card.height;

  // Every side with viewport room, in the order they have always been tried.
  const roomy: Placement[] = [];
  if (right <= maxLeft) roomy.push({ left: right, top: alignedTop, side: 'right', clamped: false });
  if (left >= margin) roomy.push({ left, top: alignedTop, side: 'left', clamped: false });
  if (below <= maxTop) roomy.push({ left: alignedLeft, top: below, side: 'below', clamped: false });
  if (above >= margin) roomy.push({ left: alignedLeft, top: above, side: 'above', clamped: false });

  const first = roomy[0];
  if (first) {
    const obstacles = (options.obstacles ?? []).filter((rect) => !isAnchorItself(anchor, rect));
    if (obstacles.length === 0) return first;

    const isClear = (placement: Placement) =>
      obstacles.every((rect) => !intersects(rectOf(placement, card), rect));

    // The first side that is clear where the card would sit anyway.
    const aligned = roomy.find(isClear);
    if (aligned) return aligned;

    // Then the same sides again, each slid along the axis it already slides on. The board
    // reads mirror | terminals | documentation, so a mirror card near the left edge has no
    // room for a 720px card on its left at all: "the other side" of it is *below*, and the
    // terminal reaches far enough left that even below has to move over a little to clear
    // it. Without this the card falls straight back to the side it was covered on.
    for (const placement of roomy) {
      const slid = slideClear(placement, card, obstacles, margin, maxLeft, maxTop);
      if (slid) return slid;
    }

    // Nothing is clear anywhere — a terminal on both sides, or one over the whole screen.
    // Today's answer: a card over a terminal is in the way, a card off the edge is
    // unreadable, and a card that moved for no gain is only confusing.
    return first;
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
