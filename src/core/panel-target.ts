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
  /** Set once an agent has been asked to implement the issue. */
  implementState: 'running' | 'done' | 'failed' | null;
  implementUrl: string | null;
  implementError: string | null;
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

  const issue: IssueTargetData | null =
    custom.kind === 'issue'
      ? {
          id: element.id,
          state: (asString(custom.issueState) as IssueTargetData['state']) ?? 'draft',
          issueUrl: asString(custom.issueUrl),
          issueError: asString(custom.issueError),
          issueTitle: asString(custom.issueTitle),
          observation: asString(custom.observation),
          implementState: asString(custom.implementState) as IssueTargetData['implementState'],
          implementUrl: asString(custom.implementUrl),
          implementError: asString(custom.implementError),
        }
      : null;

  // An image gets a collapse control whether or not it carries documentation: an image is
  // either big enough to read or small enough to stay out of the way.
  const collapsible: CollapsibleTargetData | null =
    element.type === 'image'
      ? { id: element.id, collapsed: custom.collapsed === true }
      : null;

  if (!docKey && !issue && !collapsible) return null;

  return {
    anchorId: docKey && holder ? holder.id : element.id,
    docKey,
    title: asString(element.text),
    issue,
    collapsible,
  };
}
