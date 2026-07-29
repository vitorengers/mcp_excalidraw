/**
 * The level below a section: the parts a reader walks through with `Alt+Left` / `Alt+Right`.
 *
 * `board-sections.ts` is the reasoning this file inherits, and it is worth reading first. A
 * section is a shape a board drew around one of its halves, carrying the key that reaches it,
 * because "Project structure" and "Development" are one project's cut of one project's
 * documentation and a constant in `App.tsx` would make the feature wrong for every other
 * board. Everything there applies here, one level down.
 *
 * What is different is that a subsection carries **no key of its own**, and that is the
 * feature rather than an omission. A section's parts are read in order — they are a section's
 * parts precisely because they are read one after another — so what they need is a step, not
 * a name to be summoned by. Twelve chords for a board with twelve parts is a keyboard nobody
 * learns; two that always mean *next* and *previous* is one anybody already has.
 *
 * ## Membership is geometric, and so is order
 *
 * A subsection belongs to the **smallest section that encloses it**. Nothing points at
 * anything: a board declares nesting by drawing it, the way `scripts/check-board-map.mjs`
 * has decided since it was written whether a card is inside a section. A parent id would be a
 * second copy of a fact the canvas already holds, and the two would drift the first time
 * somebody dragged a shape.
 *
 * The order inside a section is the same answer: down the board, then across. A
 * `customData.order` is *read*, but it decides nothing — where the two disagree, the drawing
 * wins and the disagreement is reported. Both being able to decide is what the open question
 * on #191 was about, and one of them has to lose: a number in a file nobody looks at cannot
 * outrank the position of the thing on screen, or moving a part would silently do nothing.
 *
 * ## Pure, for the reason the section resolver is pure
 *
 * A hotkey that does nothing compiles perfectly. So the whole decision — which section the
 * viewport is on, which part of it, and what one step lands on — is a function that
 * `scripts/check-board-subsections.mjs` runs against boards built in memory, and the
 * component is left with `scrollToContent` and nothing to be wrong about.
 */

import { BOARD_SECTION_KIND, BoardSectionElement } from './board-sections.js';

export const BOARD_SUBSECTION_KIND = 'board-subsection';

export interface BoardSubsection {
  elementId: string;
  title: string;
  /** The section this part was drawn inside. A step never crosses it. */
  sectionId: string;
}

export interface BoardSubsectionGroup {
  sectionId: string;
  sectionTitle: string;
  /** Reading order: down the board, then across. Empty for a section with no parts. */
  subsections: BoardSubsection[];
}

/**
 * Why a board's claim was not honoured.
 *
 * `homeless` and `malformed` drop the shape; `order` keeps it and drops only the number.
 * They are one list because they are one question — what did this board say that this
 * resolver did not do — and a key silently doing nothing is what
 * `describeIgnoredSubsectionClaims` exists to prevent, exactly as in `board-sections.ts`.
 */
export type IgnoredSubsectionReason = 'homeless' | 'malformed' | 'order';

export interface IgnoredSubsectionClaim {
  elementId: string;
  title: string;
  reason: IgnoredSubsectionReason;
  /** Where it actually sits, for an `order` that disagreed. 1-based, as `order` is written. */
  position?: number;
  /** What it declared, for an `order` that disagreed. */
  declared?: number;
}

export interface BoardSubsections {
  /** Every section on the board, in reading order, whether or not it has parts. */
  groups: BoardSubsectionGroup[];
  ignored: IgnoredSubsectionClaim[];
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScenePoint {
  x: number;
  y: number;
}

const asTitle = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const kindOf = (element: BoardSectionElement): unknown => (element.customData ?? {}).kind;

/** Down the board, then across — the order `resolveBoardSectionHotkeys` settles ties by. */
const inReadingOrder = <T extends Box>(a: T, b: T): number => (a.y - b.y) || (a.x - b.x);

/** Does this shape sit entirely within that one? The containment `check-board-map` uses. */
const encloses = (outer: Box, inner: Box): boolean =>
  outer.x <= inner.x
  && outer.y <= inner.y
  && outer.x + outer.width >= inner.x + inner.width
  && outer.y + outer.height >= inner.y + inner.height;

/** Zero inside the box, and the straight-line distance to its edge outside it. */
function distanceTo(box: Box, point: ScenePoint): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
}

const contains = (box: Box, point: ScenePoint): boolean =>
  point.x >= box.x && point.x <= box.x + box.width
  && point.y >= box.y && point.y <= box.y + box.height;

/**
 * Read a board's sections and their parts.
 *
 * Every section comes back, including the ones with nothing drawn inside them: a section
 * with no parts is not an error, it is most boards, and a caller asking "what can I step
 * between here" wants the empty answer rather than a missing one.
 */
export function resolveBoardSubsections(
  elements: readonly BoardSectionElement[]
): BoardSubsections {
  const live = elements.filter((element) => !element.isDeleted);

  const sections = live
    .filter((element) => kindOf(element) === BOARD_SECTION_KIND)
    .slice()
    .sort(inReadingOrder);

  const parts = live
    .filter((element) => kindOf(element) === BOARD_SUBSECTION_KIND)
    .slice()
    .sort(inReadingOrder);

  const groups: BoardSubsectionGroup[] = sections.map((section) => ({
    sectionId: section.id,
    sectionTitle: asTitle((section.customData ?? {}).title),
    subsections: [],
  }));
  const byId = new Map(groups.map((group) => [group.sectionId, group]));
  const ignored: IgnoredSubsectionClaim[] = [];

  for (const part of parts) {
    const custom = part.customData ?? {};
    const title = asTitle(custom.title);
    if (!title) {
      ignored.push({ elementId: part.id, title: '', reason: 'malformed' });
      continue;
    }

    // The smallest, so that a section drawn inside another takes its own parts rather than
    // handing them to whatever else happens to be around them.
    const home = sections
      .filter((section) => encloses(section, part))
      .sort((a, b) => (a.width * a.height) - (b.width * b.height))[0];

    if (!home) {
      ignored.push({ elementId: part.id, title, reason: 'homeless' });
      continue;
    }

    byId.get(home.id)?.subsections.push({ elementId: part.id, title, sectionId: home.id });
  }

  // After the walk, because a declared order is a claim about a *list* and the list is not
  // finished until every part has found its section.
  for (const group of groups) {
    group.subsections.forEach((subsection, at) => {
      const declared = (live.find((element) => element.id === subsection.elementId)
        ?.customData ?? {}).order;
      if (typeof declared !== 'number' || !Number.isFinite(declared)) return;
      if (declared === at + 1) return;
      ignored.push({
        elementId: subsection.elementId,
        title: subsection.title,
        reason: 'order',
        position: at + 1,
        declared,
      });
    });
  }

  return { groups, ignored };
}

/**
 * Where one step lands, given where the viewport is looking.
 *
 * Three decisions, and #191 left all three open. They are answered here rather than in the
 * component so that they are answered somewhere a check can read:
 *
 * **The section is the one the viewport is on, or the nearest one.** Not "nothing": a reader
 * halfway between two sections pressing a key that does nothing has learnt that the key is
 * unreliable, which is worse than landing somewhere they can see.
 *
 * **The first press lands rather than steps.** From a point inside no part — the top of a
 * section, its title, the gap between two — the nearest part is where the step lands, so the
 * first press puts the reader on the walk and the second one moves them along it. Stepping
 * from a part they were not on would skip one for no reason they could see.
 *
 * **It stops at the ends; it does not wrap.** A section is a short walk, and wrapping makes
 * the end of it the one boundary the reader cannot feel. The last part comes back again,
 * rather than `null` — the caller has to know that this key was the board's, because on
 * Windows the alternative is the browser taking `Alt+Right` and navigating Forward out of the
 * page. A step that has nowhere to go still has to be swallowed.
 *
 * `null` means the board offered nothing at all: no sections, or none with any parts. That is
 * the case that leaves `Alt+Left` and `Alt+Right` as Back and Forward, which is every board
 * that never drew a subsection.
 */
export function stepBetweenSubsections(
  elements: readonly BoardSectionElement[],
  viewportCentre: ScenePoint,
  direction: 1 | -1
): BoardSubsection | null {
  const { groups } = resolveBoardSubsections(elements);
  const walkable = groups.filter((group) => group.subsections.length > 0);
  if (walkable.length === 0) return null;

  const boxOf = (id: string): Box | null => {
    const element = elements.find((candidate) => candidate.id === id && !candidate.isDeleted);
    return element ? { x: element.x, y: element.y, width: element.width, height: element.height } : null;
  };

  const here = walkable
    .map((group) => ({ group, box: boxOf(group.sectionId) }))
    .filter((candidate): candidate is { group: BoardSubsectionGroup; box: Box } => candidate.box !== null)
    .sort((a, b) => distanceTo(a.box, viewportCentre) - distanceTo(b.box, viewportCentre))[0];
  if (!here) return null;

  const parts = here.group.subsections
    .map((subsection) => ({ subsection, box: boxOf(subsection.elementId) }))
    .filter((candidate): candidate is { subsection: BoardSubsection; box: Box } => candidate.box !== null);
  if (parts.length === 0) return null;

  const on = parts.findIndex((part) => contains(part.box, viewportCentre));
  const at = on >= 0
    ? Math.min(Math.max(on + direction, 0), parts.length - 1)
    // On no part at all: land on the nearest rather than step from a part nobody was on.
    : parts.reduce((closest, part, index) =>
        distanceTo(part.box, viewportCentre) < distanceTo(parts[closest]!.box, viewportCentre)
          ? index
          : closest, 0);

  return parts[at]?.subsection ?? null;
}

/** What to print when a board declares a part it cannot have, or a number it does not get. */
export function describeIgnoredSubsectionClaims(
  ignored: readonly IgnoredSubsectionClaim[]
): string {
  return ignored
    .map((claim) => {
      const named = claim.title ? `"${claim.title}"` : claim.elementId;
      if (claim.reason === 'malformed') return `${named} is marked as a subsection but names nothing`;
      if (claim.reason === 'homeless') return `${named} is drawn inside no section, so nothing steps onto it`;
      return `${named} declares order ${claim.declared} but is drawn ${claim.position}${
        claim.position === 1 ? 'st' : claim.position === 2 ? 'nd' : claim.position === 3 ? 'rd' : 'th'
      } on the board, and the board wins`;
    })
    .join('; ');
}
