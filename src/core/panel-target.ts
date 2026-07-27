/**
 * What the documentation panel should show for the current selection — including nothing.
 *
 * Written as one function returning one answer, rather than as a sequence of state
 * updates, because the bug it replaces was a missing clear: the path that handled an
 * emptied selection cleared the document and returned, leaving the issue block, the
 * collapse control and the panel's anchor pointing at a shape nobody had selected. A
 * function that returns `null` cannot forget to clear half of something.
 *
 * The walk-up here — label, then container, then the smallest enclosing shape — is the
 * other reason this is worth having on its own: clicking a label instead of the box it
 * sits in was a real defect once, and it compiled perfectly.
 */

import { PanelRunState } from './issue-appearance.js';
import { MIRROR_KIND } from './project-board-layout.js';

export interface PanelElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  containerId?: string | null;
  customData?: Record<string, unknown> | null;
  isDeleted?: boolean;
}

export interface IssueTargetData {
  id: string;
  state: 'draft' | 'running' | 'created' | 'failed';
  issueUrl: string | null;
  issueError: string | null;
  issueTitle: string | null;
  observation: string | null;
  /**
   * Files attached as reference material for the run, by id in the server's file store.
   *
   * An explicit list rather than Excalidraw group membership: a group is a user-facing
   * concept, so grouping a block with its neighbours for layout would silently change
   * what the agent sees, and ungrouping would silently take it away.
   */
  images: string[];
  /** Set once an agent has been asked to implement the issue. */
  implementState: PanelRunState;
  implementUrl: string | null;
  implementError: string | null;
  /**
   * When the run started and when it stopped, ISO, so the panel can show how long it has
   * been going with nothing selected and no network.
   *
   * Instants, not a duration: the clock runs in the browser off `implementStartedAt`, so
   * the server writes these once each rather than once a second. `implementEndedAt` is
   * null while the run is live, which is what makes the clock live rather than a total.
   */
  implementStartedAt: string | null;
  implementEndedAt: string | null;
}

export interface CollapsibleTargetData {
  id: string;
  collapsed: boolean;
}

export interface PanelTarget {
  /** The shape the card hangs off — the one holding the document, not the one clicked. */
  anchorId: string;
  docKey: string | null;
  /** Heading for a document that does not exist yet; the shape's own text. */
  title: string | null;
  issue: IssueTargetData | null;
  collapsible: CollapsibleTargetData | null;
}

function docKeyOf(element: PanelElement | undefined): string | null {
  const value = element?.customData?.docKey;
  return typeof value === 'string' && value ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * A run state, or null for anything that is not one.
 *
 * Narrowed rather than cast, because this is now read off a shape as well as off the
 * server's own record: a `customData.implementState` the mirror never writes must read as
 * "nothing known", not as a fifth state the panel has no branch for.
 */
function asRunState(value: unknown): PanelRunState {
  return value === 'running' || value === 'done' || value === 'failed' || value === 'interrupted'
    ? value
    : null;
}

/** A list of ids, or an empty one — never undefined, so the panel can just map over it. */
function asIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * Shapes that stand for a GitHub issue: a block someone authored, and a card the mirror
 * drew. They are drawn by different code and live in different places — the block is a real
 * element on the server, the card is redrawn from GitHub on every read and never synced —
 * but to the panel they are the same thing, and a reader who can act on one should be able
 * to act on the other.
 */
function issueShapeOf(
  element: PanelElement,
  elements: readonly PanelElement[]
): PanelElement | undefined {
  const stands = (candidate: PanelElement | undefined): boolean => {
    const custom = candidate?.customData ?? {};
    return custom.kind === 'issue'
      || (custom.kind === MIRROR_KIND && custom.role === 'card');
  };

  if (stands(element)) return element;
  // Clicking a card usually selects the card, but a click that lands on its label has to
  // resolve to the same issue — the same walk-up the document below does.
  if (element.containerId) {
    const container = elements.find((candidate) => candidate.id === element.containerId);
    if (stands(container)) return container;
  }
  return undefined;
}

/**
 * What a mirrored card can say about its issue on its own.
 *
 * Almost nothing, deliberately. A card exists because the issue does, so its state is
 * `created` by construction, and the body is read from the server against the issue URL
 * rather than taken from the card — the mirror redraws a card from GitHub on every read, so
 * it is the wrong place to remember anything.
 *
 * The one exception is the run, and it is not a memory: the mirror *writes* the run onto
 * the card as it draws it, from the record the server keeps against the issue URL, because
 * that is what a dashed or solid outline on the board is drawn from. This used to hardcode
 * `null` anyway, so a card sitting in **In Progress** offered **Implement / Fix** until a
 * `gh issue view` came back a second later — the shape under the pointer already knew
 * better. Reading it here costs nothing and is right on the first frame.
 */
function mirrorCardIssue(
  card: PanelElement,
  elements: readonly PanelElement[]
): IssueTargetData | null {
  const issueUrl = asString(card.customData?.issueUrl);
  if (!issueUrl) return null;

  const label = elements.find((candidate) => candidate.containerId === card.id);
  return {
    id: card.id,
    state: 'created',
    issueUrl,
    issueError: null,
    issueTitle: asString(card.text) ?? asString(label?.text),
    observation: null,
    // A card exists because the issue does, so there is no run left to attach anything to.
    images: [],
    implementState: asRunState(card.customData?.implementState),
    // None of the rest is drawn on a card: the outline is the only thing the mirror has to
    // say about a run, and the pull request, the failure and the two instants are what the
    // panel reads from the server. Inventing them here would put two answers to one
    // question on the board.
    implementUrl: null,
    implementError: null,
    implementStartedAt: null,
    implementEndedAt: null,
  };
}

/**
 * Resolve the selection to what the panel should show.
 *
 * Returns `null` when there is nothing to show — nothing selected, several things
 * selected, or a shape that carries no document, is not an issue block and is not an
 * image. A shape with nothing to say should get no card rather than an empty one.
 *
 * A multiple selection deliberately resolves to nothing: showing one shape's document
 * while several are highlighted reads as if it described all of them.
 */
export function resolvePanelTarget(
  elements: readonly PanelElement[],
  selectedIds: readonly string[]
): PanelTarget | null {
  if (selectedIds.length !== 1) return null;

  const selectedId = selectedIds[0];
  const element = elements.find(
    (candidate) => candidate.id === selectedId && !candidate.isDeleted
  );
  if (!element) return null;

  // Clicking a box means clicking its label, which is a separate element and holds no
  // docKey of its own. Fall back to the shape the label sits in: its bound container when
  // there is one, otherwise the smallest shape enclosing it — the smallest so that nesting
  // resolves to the innermost box, not the section behind it.
  let holder: PanelElement | undefined = docKeyOf(element) ? element : undefined;
  if (!holder && element.containerId) {
    const container = elements.find((candidate) => candidate.id === element.containerId);
    if (docKeyOf(container)) holder = container;
  }
  if (!holder) {
    holder = elements
      .filter(
        (candidate) =>
          candidate.id !== element.id &&
          !candidate.isDeleted &&
          docKeyOf(candidate) &&
          candidate.x <= element.x &&
          candidate.y <= element.y &&
          candidate.x + candidate.width >= element.x + element.width &&
          candidate.y + candidate.height >= element.y + element.height
      )
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
  }

  const docKey = docKeyOf(holder);
  const custom = element.customData ?? {};

  const issueShape = issueShapeOf(element, elements);
  const issueCustom = issueShape?.customData ?? {};
  const issue: IssueTargetData | null = !issueShape
    ? null
    : issueCustom.kind === MIRROR_KIND
      ? mirrorCardIssue(issueShape, elements)
      : {
          id: issueShape.id,
          state: (asString(issueCustom.issueState) as IssueTargetData['state']) ?? 'draft',
          issueUrl: asString(issueCustom.issueUrl),
          issueError: asString(issueCustom.issueError),
          issueTitle: asString(issueCustom.issueTitle),
          observation: asString(issueCustom.observation),
          images: asIdList(issueCustom.issueImages),
          implementState: asRunState(issueCustom.implementState),
          implementUrl: asString(issueCustom.implementUrl),
          implementError: asString(issueCustom.implementError),
          implementStartedAt: asString(issueCustom.implementStartedAt),
          implementEndedAt: asString(issueCustom.implementEndedAt),
        };

  // An image gets a collapse control whether or not it carries documentation: an image is
  // either big enough to read or small enough to stay out of the way.
  const collapsible: CollapsibleTargetData | null =
    element.type === 'image'
      ? { id: element.id, collapsed: custom.collapsed === true }
      : null;

  if (!docKey && !issue && !collapsible) return null;

  return {
    // The card hangs off the shape the panel is about, which is not always the shape that
    // was clicked: a click on a label resolves to the box or the card holding it.
    anchorId: docKey && holder ? holder.id : (issueShape?.id ?? element.id),
    docKey,
    title: asString(element.text),
    issue,
    collapsible,
  };
}
