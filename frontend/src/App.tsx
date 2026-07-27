import React, { useState, useEffect, useRef } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI,
  exportToBlob,
  exportToSvg,
  getCommonBounds,
  sceneCoordsToViewportCoords
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, NonDeleted, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import { CollapsibleTarget, CommentPosted, IssueTarget } from './components/DocsPanel'
import { AnchoredDocsPanel } from './components/AnchoredDocsPanel'
import type { Rect } from '../../src/core/anchored-placement'
import { resolvePanelTarget } from '../../src/core/panel-target'
import type { PanelElement } from '../../src/core/panel-target'
import { referenceImageName } from '../../src/core/pasted-images'
import { layoutLabel } from '../../src/core/text-layout'
import {
  layoutBoard,
  boardWidth,
  columnAt,
  MIRROR_KIND
} from '../../src/core/project-board-layout'
import type { CardImplementState, DraftBlock, MirrorColumn } from '../../src/core/project-board-layout'
import type { ProjectBoard } from '../../src/core/project-board-types'
import { TerminalPanel } from './components/TerminalPanel'
import {
  TERMINAL_KIND,
  TERMINAL_SIZE,
  terminalBlockElement,
  terminalGrid,
  terminalOrigin
} from '../../src/core/terminal-block'
import { WorkspaceTabs, WorkspaceSummary } from './components/WorkspaceTabs'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'

// Type definitions
type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  boundElements?: any[] | null;
  containerId?: string | null;
  locked?: boolean;
  // Arrow element binding
  start?: { id: string };
  end?: { id: string };
  strokeStyle?: string;
  endArrowhead?: string;
  startArrowhead?: string;
  // Image element fields
  fileId?: string;
  status?: string;
  scale?: [number, number];
  angle?: number;
  link?: string | null;
  customData?: Record<string, unknown> | null;
}

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
  requestId?: string;
  scrollToContent?: boolean;
  scrollToElementId?: string;
  scrollToElementIds?: string[];
  viewportZoomFactor?: number;
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  files?: Record<string, unknown>;
  count?: number;
  error?: string;
  message?: string;
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
const AUTO_SYNC_DEBOUNCE_MS = 1200;

/**
 * How often the mirror re-reads the project.
 *
 * Polled because there is nothing to subscribe to: `projects_v2_item` webhooks are
 * organisation-scoped, and a user account has no hooks endpoint at all. Twenty seconds is
 * a compromise between a status changed on GitHub showing up promptly and a `gh` process
 * being spawned all day.
 */
const PROJECT_BOARD_POLL_MS = 20000;

/** Distance between the mirror's right edge and the board's own left edge. */
const MIRROR_GAP = 120;

/**
 * The key that jumps the viewport to the mirror.
 *
 * `Alt` because Excalidraw owns the bare letters — every tool has one — and much of
 * `Ctrl+Shift`. Matched on `code` rather than `key` so it survives a keyboard layout
 * where Alt produces a different character.
 */
const MIRROR_HOTKEY_CODE = 'KeyB';

/**
 * The key that jumps the viewport to the terminal.
 *
 * `Alt+T`, alongside `Alt+B` for the mirror: the same reasoning about who owns which keys,
 * and `T` for the thing it brings into view. It does a little more than the mirror's key —
 * with no block on the board it places one first, which is the way back from having deleted
 * a shape that is derived and therefore never restored from anywhere.
 */
const TERMINAL_HOTKEY_CODE = 'KeyT';

/** How long to wait before telling the server the block was resized. */
const TERMINAL_RESIZE_DEBOUNCE_MS = 400;

type CustomData = Record<string, unknown> | null | undefined;

const customDataOf = (element: { customData?: CustomData } | undefined): Record<string, unknown> =>
  (element?.customData ?? {}) as Record<string, unknown>;

/** Elements the mirror owns. Everything else on the canvas is the board's own drawing. */
const isMirrorElement = (element: { customData?: CustomData }): boolean =>
  customDataOf(element).kind === MIRROR_KIND;

/** The block the terminal is drawn over. */
const isTerminalElement = (element: { customData?: CustomData }): boolean =>
  customDataOf(element).kind === TERMINAL_KIND;

/**
 * Shapes this board does not author, and therefore never saves.
 *
 * The mirror is rebuilt from GitHub and the terminal exists for as long as its shell does.
 * Both are stripped before the autosync, and both again by `scripts/export-board.mjs` —
 * two doors for one rule, because the element store is shared and only one of them needs
 * to be missed.
 */
const isDerivedElement = (element: { customData?: CustomData }): boolean =>
  isMirrorElement(element) || isTerminalElement(element);

/**
 * A block the `+` dropped, waiting for its run to produce a real card.
 *
 * Authored rather than mirrored: it is a real issue block, it persists, and it is the
 * user's until the issue exists. Only the container is marked, so counting drafts cannot
 * count a label twice.
 */
const isDraftBlock = (element: { customData?: CustomData; containerId?: string | null }): boolean =>
  customDataOf(element).projectBoardDraft === true && !element.containerId;

/**
 * The shape whose label is being typed into, if any.
 *
 * Excalidraw edits a bound label in a real textarea over the container, so what is open is
 * named by the *container*: it is the container that must be left alone while a relayout
 * moves everything around it.
 */
const editingDraftId = (api: ExcalidrawImperativeAPI): string => {
  const editing = (api.getAppState() as unknown as Record<string, unknown>).editingTextElement as
    { id?: string; containerId?: string | null } | null | undefined;
  if (!editing) return '';
  return String(editing.containerId ?? editing.id ?? '');
};

/**
 * A draft block reduced to what the placement needs.
 *
 * `draftCreatedAt` is what orders the stack. A block dropped before that field was written
 * carries none; the layout keeps those in the order they arrive, so an old scene still
 * lays out the same way twice running.
 */
/**
 * The timestamp a draft's id was built from, for when the field is gone.
 *
 * `draftCreatedAt` is written onto every block the `+` drops, and it survives the server
 * intact — a round trip through `POST /api/elements` returns it unchanged. It does not
 * survive the browser: by the time the block is in the scene its `customData` holds `kind`,
 * `projectBoardDraft` and `sectionOptionId` — written in the same object literal — and not
 * this one.
 *
 * Reading the stamp back off the id was rejected when this was written, on the grounds that
 * a timestamp seeded into an id is a weak key. That reasoning still holds, which is why this
 * is a fallback and the field is still written and still preferred. But a weak key that
 * survives beats a strong one that does not: with neither, `(b.createdAt ?? 0) - (a.createdAt
 * ?? 0)` is zero for every pair, the sort is stable, and the newest block lands at the bottom
 * of the column instead of the top.
 */
const createdAtFromId = (id: string): number | null => {
  const stamp = /^pbdraft-(\d+)/.exec(id)?.[1];
  if (!stamp) return null;
  const value = Number(stamp);
  return Number.isFinite(value) ? value : null;
};

const draftBlockOf = (element: { id: string; height: number; customData?: CustomData }): DraftBlock => {
  const custom = customDataOf(element);
  const createdAt = typeof custom.draftCreatedAt === 'number'
    ? custom.draftCreatedAt
    : createdAtFromId(element.id);
  return {
    id: element.id,
    sectionOptionId: String(custom.sectionOptionId ?? ''),
    height: element.height,
    ...(createdAt === null ? {} : { createdAt })
  };
};

interface LibraryElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fontSize?: number;
  containerId?: string | null;
  customData?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** The library's issue block, or nothing when no library shipped one. */
const findIssueBlockTemplate = (items: unknown[]): LibraryElement[] | null => {
  for (const item of items) {
    const elements = (item as { elements?: LibraryElement[] })?.elements
    if (Array.isArray(elements) && elements.some((element) => element?.customData?.kind === 'issue')) {
      return elements
    }
  }
  return null
}

/**
 * Make one issue block from the library template, sized to a column.
 *
 * From the library rather than built here on purpose: what makes a block functional is
 * `customData.kind`, and a second definition of that shape would drift from the one the
 * library ships the moment either changed.
 */
const instantiateIssueBlock = (
  template: LibraryElement[],
  placement: { x: number; y: number; width: number },
  sectionOptionId: string,
  createdAt: number
): Partial<ExcalidrawElement>[] => {
  const shape = template.find((element) => element?.customData?.kind === 'issue')
  if (!shape) return []

  const shapeId = `pbdraft-${createdAt}`
  const labelId = `${shapeId}-label`
  const labelTemplate = template.find((element) => element.containerId === shape.id)
  const height = shape.height

  const block = {
    ...shape,
    id: shapeId,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height,
    locked: false,
    boundElements: labelTemplate ? [{ id: labelId, type: 'text' }] : null,
    customData: {
      ...(shape.customData ?? {}),
      kind: 'issue',
      // What ties the block to a column, and to the card that will replace it.
      projectBoardDraft: true,
      sectionOptionId,
      // What orders the drafts in a column, newest on top. Written out rather than read
      // back off the id: a timestamp seeded into an id is a weak key, and an id is the
      // one field anything on the canvas is free to rewrite.
      draftCreatedAt: createdAt
    }
  } as unknown as Partial<ExcalidrawElement>

  if (!labelTemplate) return [block]

  const fontSize = Number(labelTemplate.fontSize ?? 16)
  const laid = layoutLabel(String(labelTemplate.text ?? ''), placement.width, fontSize)
  const label = {
    ...labelTemplate,
    id: labelId,
    containerId: shapeId,
    text: laid.text,
    originalText: laid.text,
    fontSize,
    width: laid.width,
    height: laid.height,
    x: placement.x + (placement.width - laid.width) / 2,
    y: placement.y + (height - laid.height) / 2,
    boundElements: null,
    customData: null
  } as unknown as Partial<ExcalidrawElement>

  return [block, label]
}

// Helper function to clean elements for Excalidraw
const cleanElementForExcalidraw = (element: ServerElement): Partial<ExcalidrawElement> => {
  const {
    createdAt,
    updatedAt,
    version,
    syncedAt,
    source,
    syncTimestamp,
    ...cleanElement
  } = element;
  return cleanElement;
}

// Helper function to validate and fix element binding data
const validateAndFixBindings = (elements: Partial<ExcalidrawElement>[]): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map(el => [el.id!, el]));

  return elements.map(element => {
    const fixedElement = { ...element };

    // Validate and fix boundElements
    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter((binding: any) => {
          // Ensure binding has required properties
          if (!binding || typeof binding !== 'object') return false;
          if (!binding.id || !binding.type) return false;

          // Ensure the referenced element exists
          const referencedElement = elementMap.get(binding.id);
          if (!referencedElement) return false;

          // Validate binding type
          if (!['text', 'arrow'].includes(binding.type)) return false;

          return true;
        });

        // Remove boundElements if empty
        if (fixedElement.boundElements.length === 0) {
          fixedElement.boundElements = null;
        }
      } else {
        // Invalid boundElements format, set to null
        fixedElement.boundElements = null;
      }
    }

    // Validate and fix containerId
    if (fixedElement.containerId) {
      const containerElement = elementMap.get(fixedElement.containerId);
      if (!containerElement) {
        // Container doesn't exist, remove containerId
        fixedElement.containerId = null;
      }
    }

    return fixedElement;
  });
}

const isImageElement = (element: Partial<ExcalidrawElement>): boolean => {
  return element.type === 'image'
}

const isFreedrawElement = (element: Partial<ExcalidrawElement>): boolean => {
  return element.type === 'freedraw'
}

const isShapeContainerType = (type: string | undefined): boolean => {
  return type === 'rectangle' || type === 'ellipse' || type === 'diamond'
}

const recenterBoundShapeTextElements = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map((el) => [el.id, el]))

  return elements.map((element) => {
    if (element.type !== 'text' || !element.containerId) {
      return element
    }

    const textElement = element as ExcalidrawElement & { type: 'text'; containerId: string; autoResize?: boolean }
    const container = elementMap.get(textElement.containerId) as (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined
    if (!container || !isShapeContainerType(container.type)) {
      return element
    }

    if (textElement.autoResize === false) {
      return element
    }

    if (
      typeof container.x !== 'number' ||
      typeof container.y !== 'number' ||
      typeof container.width !== 'number' ||
      typeof container.height !== 'number' ||
      typeof textElement.width !== 'number' ||
      typeof textElement.height !== 'number'
    ) {
      return element
    }

    return {
      ...element,
      x: container.x + (container.width - textElement.width) / 2,
      y: container.y + (container.height - textElement.height) / 2,
    }
  })
}

const normalizeImageElement = (element: Partial<ExcalidrawElement>): Partial<ExcalidrawElement> => {
  const img = element as any
  return {
    ...img,
    angle: img.angle || 0,
    strokeColor: img.strokeColor || 'transparent',
    backgroundColor: img.backgroundColor || 'transparent',
    fillStyle: img.fillStyle || 'solid',
    strokeWidth: img.strokeWidth || 1,
    strokeStyle: img.strokeStyle || 'solid',
    roughness: img.roughness ?? 0,
    opacity: img.opacity ?? 100,
    groupIds: img.groupIds || [],
    roundness: null,
    seed: img.seed || Math.floor(Math.random() * 1000000),
    version: img.version || 1,
    versionNonce: img.versionNonce || Math.floor(Math.random() * 1000000),
    isDeleted: img.isDeleted ?? false,
    boundElements: img.boundElements || null,
    link: img.link || null,
    locked: img.locked || false,
    status: img.status || 'saved',
    fileId: img.fileId,
    scale: img.scale || [1, 1],
  }
}

const normalizeFreedrawElement = (element: Partial<ExcalidrawElement>): Partial<ExcalidrawElement> => {
  const freedraw = element as any
  return {
    ...freedraw,
    angle: freedraw.angle || 0,
    backgroundColor: freedraw.backgroundColor || 'transparent',
    fillStyle: freedraw.fillStyle || 'solid',
    strokeWidth: freedraw.strokeWidth || 1,
    strokeStyle: freedraw.strokeStyle || 'solid',
    roughness: freedraw.roughness ?? 1,
    opacity: freedraw.opacity ?? 100,
    groupIds: freedraw.groupIds || [],
    roundness: null,
    seed: freedraw.seed || Math.floor(Math.random() * 1000000),
    version: freedraw.version || 1,
    versionNonce: freedraw.versionNonce || Math.floor(Math.random() * 1000000),
    isDeleted: freedraw.isDeleted ?? false,
    boundElements: freedraw.boundElements || null,
    link: freedraw.link || null,
    locked: freedraw.locked || false,
    points: freedraw.points || [],
    pressures: freedraw.pressures || [],
    simulatePressure: freedraw.simulatePressure ?? true,
    lastCommittedPoint: freedraw.lastCommittedPoint || null,
  }
}

// Helper: restore startBinding/endBinding/boundElements after convertToExcalidrawElements strips them
const restoreBindings = (
  convertedElements: readonly any[],
  originalElements: Partial<ExcalidrawElement>[]
): any[] => {
  const originalMap = new Map<string, any>();
  for (const el of originalElements) {
    if (el.id) originalMap.set(el.id, el);
  }

  return convertedElements.map((el: any) => {
    const orig = originalMap.get(el.id);
    if (!orig) return el;

    const patched = { ...el };

    if (orig.startBinding && !el.startBinding) {
      patched.startBinding = orig.startBinding;
    }
    if (orig.endBinding && !el.endBinding) {
      patched.endBinding = orig.endBinding;
    }
    if (orig.boundElements && (!el.boundElements || el.boundElements.length === 0)) {
      patched.boundElements = orig.boundElements;
    }
    if (orig.elbowed !== undefined && el.elbowed === undefined) {
      patched.elbowed = orig.elbowed;
    }

    return patched;
  });
};

const convertElementsPreservingImageProps = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  if (elements.length === 0) return []

  const validatedElements = validateAndFixBindings(elements)
  const imageElements = validatedElements.filter(isImageElement).map(normalizeImageElement)
  const freedrawElements = validatedElements.filter(isFreedrawElement).map(normalizeFreedrawElement)
  const nonImageElements = validatedElements.filter(el => !isImageElement(el) && !isFreedrawElement(el))
  // convertToExcalidrawElements may expand labeled shapes into [shape, textElement],
  // so we cannot assume a 1:1 mapping — return all converted elements directly.
  const convertedNonImageElements = convertToExcalidrawElements(nonImageElements as any, { regenerateIds: false })
  const restoredNonImageElements = restoreBindings(convertedNonImageElements, nonImageElements)
  return recenterBoundShapeTextElements([...restoredNonImageElements, ...imageElements, ...freedrawElements])
}

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  // Ref so WS message handlers (captured in stale closures) always see the latest API instance
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    try {
      const saved = window.localStorage?.getItem('excalidraw-canvas-theme')
      if (saved === 'light' || saved === 'dark') return saved
    } catch (error) {
      console.warn('Failed to read theme from localStorage:', error)
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  // Boards, one per project
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<string>('default')
  // WebSocket handlers close over their creation-time scope, so the ref is what the
  // async paths read — the state alone would send stale ids after a tab switch.
  const activeWorkspaceRef = useRef<string>('default')

  /** Append the active workspace to an API path, so no request is ever board-agnostic. */
  const apiUrl = (path: string): string => {
    const separator = path.includes('?') ? '&' : '?'
    return `${path}${separator}workspace=${encodeURIComponent(activeWorkspaceRef.current)}`
  }

  // Documentation panel: which shape's doc is on screen
  const [selectedDoc, setSelectedDoc] = useState<{ key: string | null; title: string | null }>({
    key: null,
    title: null
  })
  const [libraryItems, setLibraryItems] = useState<unknown[]>([])
  const [collapsible, setCollapsible] = useState<CollapsibleTarget | null>(null)
  const [issue, setIssue] = useState<IssueTarget | null>(null)

  /**
   * The shape the card is pinned to, and where that shape currently is on screen.
   *
   * The id lives in a ref because it is read inside onChange, which fires far too often
   * to want a re-render for; the rect lives in state because moving the card *is* the
   * re-render. They are recomputed together on every change, which is what makes the
   * card follow a pan, a zoom or a dragged block.
   */
  const docsAnchorIdRef = useRef<string | null>(null)
  const [docsAnchor, setDocsAnchor] = useState<{
    rect: Rect
    viewport: { width: number; height: number }
    suppressed: boolean
  } | null>(null)
  /** A card the reader closed. Cleared as soon as the selection moves elsewhere. */
  const [dismissedAnchorId, setDismissedAnchorId] = useState<string | null>(null)

  /**
   * Ask the server to research the observation and open an issue.
   *
   * The state flips to running immediately rather than on the response: the run takes
   * minutes, and a block that looks idle invites a second click — which is exactly how
   * you end up with two issues for one observation.
   */
  const createIssueFromBlock = async (elementId: string): Promise<void> => {
    setIssue((current) => (current?.id === elementId ? { ...current, state: 'running' } : current))
    try {
      const response = await fetch(apiUrl(`/api/issue-block/${elementId}`), { method: 'POST' })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        setIssue((current) =>
          current?.id === elementId
            ? { ...current, state: 'failed', issueError: body?.error ?? `HTTP ${response.status}` }
            : current)
      }
      // Success arrives over the WebSocket as an element update, not here.
    } catch (error) {
      setIssue((current) =>
        current?.id === elementId
          ? { ...current, state: 'failed', issueError: (error as Error).message }
          : current)
    }
  }

  /**
   * Clear a `running` research run whose agent is gone.
   *
   * The run has no time limit, so nothing else ever clears that state — and the create
   * control is hidden while it holds, which would leave a lost run holding the block for
   * good. Addressed by element id, unlike the implement reset: an observation is only ever
   * a block, so there is no mirrored card to reach here.
   */
  const resetIssueOnBlock = async (target: IssueTarget): Promise<string | null> => {
    try {
      const response = await fetch(apiUrl(`/api/issue-block/${target.id}`), { method: 'DELETE' })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        return body?.error ?? `HTTP ${response.status}`
      }
      // Mirrors what the server writes, rather than waiting for it to arrive: a block that
      // already has an issue goes back to showing it, one that has none to offering a run.
      setIssue((current) =>
        current?.id === target.id
          ? { ...current, state: current.issueUrl ? 'created' : 'draft', issueError: null }
          : current)
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  /**
   * Ask an agent to implement the issue this block produced.
   *
   * Same shape as the run that created the issue, and running for the same reason: the
   * work takes long enough that a block which still looks idle invites a second click,
   * and two agents writing to one repository is a worse outcome than a slow one.
   */
  const implementIssueFromBlock = async (target: IssueTarget): Promise<string | null> => {
    if (!target.issueUrl) return 'This block has no issue to implement yet.'

    setIssue((current) => (current?.id === target.id ? { ...current, implementState: 'running' } : current))
    const fail = (message: string): string => {
      setIssue((current) =>
        current?.id === target.id
          ? { ...current, implementState: 'failed', implementError: message }
          : current)
      return message
    }

    try {
      // Addressed by issue URL rather than by element: a mirrored card has no element on
      // the server, and the issue is what is being implemented either way.
      const response = await fetch(apiUrl('/api/implement'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target.issueUrl })
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        return fail(body?.error ?? `HTTP ${response.status}`)
      }
      // Success arrives over the WebSocket for a block, and by asking for a card.
      return null
    } catch (error) {
      return fail((error as Error).message)
    }
  }

  /**
   * Add an observation to an issue that already exists, as a GitHub comment.
   *
   * Nothing on the element changes, and that is deliberate: the issue is still `created`,
   * an implementation already made is still made, and a comment must not make the block
   * look runnable again. So this writes no state — it hands back the issue as it now
   * stands, and the panel renders that.
   */
  const addObservationToIssue = async (
    target: IssueTarget,
    body: string
  ): Promise<CommentPosted> => {
    if (!target.issueUrl) return { error: 'This block has no issue to comment on yet.' }

    try {
      // By issue URL, like implementing: a mirrored card has no element on the server.
      const response = await fetch(apiUrl('/api/issue/comment'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target.issueUrl, body })
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) return { error: payload?.error ?? `HTTP ${response.status}` }
      return { error: null, issue: payload?.issue ?? null }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }

  /**
   * Clear a `running` implementation whose agent is gone.
   *
   * There is no timeout on an implementation, so nothing else ever clears that state.
   * The server refuses while a run is in flight, which is the case worth refusing — the
   * element cannot tell a live run from an abandoned one, and the server can.
   */
  const resetImplementOnBlock = async (target: IssueTarget): Promise<string | null> => {
    if (!target.issueUrl) return 'This block has no issue to reset.'

    const fail = (message: string): string => {
      setIssue((current) =>
        current?.id === target.id ? { ...current, implementError: message } : current)
      return message
    }

    try {
      const response = await fetch(apiUrl('/api/implement'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target.issueUrl })
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        return fail(body?.error ?? `HTTP ${response.status}`)
      }
      setIssue((current) =>
        current?.id === target.id
          ? { ...current, implementState: null, implementUrl: null, implementError: null }
          : current)
      return null
    } catch (error) {
      return fail((error as Error).message)
    }
  }

  /**
   * Ceiling on one reference image.
   *
   * The observation says N images and puts no number on it, and neither does this — but a
   * dataURL is base64 in a map that lives in the server process, so one image the size of
   * a video is a different kind of mistake from ten screenshots. Ten megabytes is well
   * past any screenshot and well short of hurting.
   */
  const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024

  const readAsDataURL = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
      reader.readAsDataURL(file)
    })

  /** Write a block's attached list, and mirror it into the panel. */
  const writeIssueImages = async (elementId: string, images: string[]): Promise<void> => {
    const element = excalidrawAPI?.getSceneElements().find((candidate) => candidate.id === elementId)
    const response = await fetch(apiUrl(`/api/elements/${elementId}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customData: { ...(customDataOf(element as { customData?: CustomData }) ?? {}), issueImages: images }
      })
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body?.error ?? `HTTP ${response.status}`)
    }
    setIssue((current) => (current?.id === elementId ? { ...current, images } : current))
  }

  /**
   * Attach reference images to a block, so the agent can look at them while it investigates.
   *
   * The bytes go to the server's file store and only the ids land on the element: an
   * element carrying dataURLs would ride in every autosync payload and in every export of
   * the board. Nothing is uploaded to GitHub — `gh issue create` has no way to attach a
   * file — so these are material for the run and nothing else.
   */
  const attachIssueImages = async (target: IssueTarget, chosen: File[]): Promise<string | null> => {
    const images = chosen.filter((file) => file.type.startsWith('image/'))
    if (!images.length) return 'Those files are not images.'

    const tooBig = images.find((file) => file.size > MAX_REFERENCE_IMAGE_BYTES)
    if (tooBig) {
      // Named through `referenceImageName`: a file off the clipboard is `image.png` at
      // best and unnamed at worst, so the name alone read as " is larger than 10 MB."
      const megabytes = MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)
      return `${referenceImageName(tooBig)} is larger than ${megabytes} MB.`
    }

    try {
      const uploads = await Promise.all(images.map(async (file) => ({
        id: `issue-image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        dataURL: await readAsDataURL(file),
        mimeType: file.type,
        created: Date.now()
      })))

      // The file store is not per-board, so this request carries no workspace — the same
      // id means the same image everywhere, which is why the ids are generated here.
      const stored = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: uploads })
      })
      if (!stored.ok) return `Could not store the images: HTTP ${stored.status}`

      await writeIssueImages(target.id, [...(target.images ?? []), ...uploads.map((file) => file.id)])
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  /**
   * Take one image back off a block.
   *
   * The reference goes; the stored file stays. Deleting it would be a guess about who else
   * holds that id, and the store is in memory anyway — it does not outlive the server.
   */
  const detachIssueImage = async (target: IssueTarget, fileId: string): Promise<string | null> => {
    try {
      await writeIssueImages(target.id, (target.images ?? []).filter((id) => id !== fileId))
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  /** Thumbnail height for a collapsed image, in scene units. */
  const COLLAPSED_IMAGE_HEIGHT = 48

  /**
   * Collapse or expand an image in place.
   *
   * The full size is stashed in customData before shrinking, because the element's
   * own width and height are what we are about to overwrite -- without it, expanding
   * could only guess, and the image would come back the wrong shape.
   */
  const toggleImageCollapse = async (elementId: string): Promise<void> => {
    if (!excalidrawAPI) return
    const element = excalidrawAPI.getSceneElements().find((candidate) => candidate.id === elementId) as
      | (ExcalidrawElement & { customData?: { collapsed?: boolean; fullSize?: { width: number; height: number } } })
      | undefined
    if (!element) return

    const isCollapsed = element.customData?.collapsed === true
    const fullSize = element.customData?.fullSize ?? { width: element.width, height: element.height }
    const ratio = element.width / (element.height || 1)

    const next = isCollapsed
      ? { width: fullSize.width, height: fullSize.height }
      : { width: Math.max(1, Math.round(COLLAPSED_IMAGE_HEIGHT * ratio)), height: COLLAPSED_IMAGE_HEIGHT }

    try {
      await fetch(apiUrl(`/api/elements/${elementId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...next,
          customData: { ...(element.customData ?? {}), collapsed: !isCollapsed, fullSize }
        })
      })
      setCollapsible({ id: elementId, collapsed: !isCollapsed })
    } catch (error) {
      console.error('Could not toggle image collapse:', error)
    }
  }
  const lastSelectedIdRef = useRef<string | null>(null)

  // Sync state management
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncInFlightRef = useRef<boolean>(false)
  const suppressAutoSyncCountRef = useRef<number>(0)
  const userInteractedRef = useRef<boolean>(false)

  /**
   * Track which selected shape the docs panel should describe.
   *
   * onChange fires on every pointer move, so this bails out unless the selection
   * actually changed — otherwise the panel would refetch continuously while dragging.
   * A multi-selection resolves to no doc: showing one shape's document while several
   * are highlighted reads as if it described all of them.
   */
  const syncSelectedDoc = (appState: { selectedElementIds?: Record<string, boolean> } | undefined): void => {
    const selectedIds = Object.keys(appState?.selectedElementIds ?? {}).filter(
      (id) => appState?.selectedElementIds?.[id]
    )
    const selectedId = selectedIds.length === 1 ? selectedIds[0] : null

    if (selectedId === lastSelectedIdRef.current) return
    lastSelectedIdRef.current = selectedId

    // The mirror's `+` is a button drawn as a shape, so selecting it is the click. Only a
    // fresh selection counts, which is what the early return above already guarantees —
    // otherwise every pointer move over it would drop another block.
    if (selectedId) {
      const scene = excalidrawAPI?.getSceneElements() ?? []
      const clicked = scene.find((candidate) => candidate.id === selectedId)
      const holder = clicked?.containerId
        ? scene.find((candidate) => candidate.id === clicked.containerId) ?? clicked
        : clicked
      const custom = customDataOf(holder)
      if (custom.kind === MIRROR_KIND && custom.role === 'add') {
        addIssueBlockToColumn(String(custom.sectionOptionId ?? ''))
        return
      }
    }

    // One answer for the whole panel, including "nothing at all". What this replaced was
    // a missing clear: the branch that handled an emptied selection cleared the document
    // and returned, so an issue block stayed fully open and the card kept an anchor
    // pointing at a shape nobody had selected. Every piece is now written on every pass,
    // so there is no half-cleared state to forget.
    const sceneElements = excalidrawAPI
      ? (excalidrawAPI.getSceneElements() as unknown as PanelElement[])
      : []
    const target = resolvePanelTarget(sceneElements, selectedIds)

    setSelectedDoc({ key: target?.docKey ?? null, title: target?.title ?? null })
    setIssue(target?.issue ?? null)
    setCollapsible(target?.collapsible ?? null)

    const anchorId = target?.anchorId ?? null
    if (anchorId !== docsAnchorIdRef.current) {
      docsAnchorIdRef.current = anchorId
      // Closing a card dismisses that shape's card, not every card from then on.
      setDismissedAnchorId(null)
    }
  }

  /**
   * Work out where the anchored shape currently sits on screen.
   *
   * Runs on every change rather than only on selection, because the card has to follow
   * the board: a pan, a zoom, a window resize and a dragged block all move the shape
   * without changing which shape it is. Scene coordinates go through Excalidraw's own
   * `sceneCoordsToViewportCoords` — the same conversion its hyperlink popup uses — and
   * `getCommonBounds` gives the axis-aligned box, so a rotated shape still gets a
   * sensible one.
   */
  const syncDocsAnchor = (
    elements: readonly ExcalidrawElement[] | undefined,
    appState: Record<string, any> | undefined
  ): void => {
    const anchorId = docsAnchorIdRef.current
    if (!anchorId || !appState || !elements) {
      setDocsAnchor((current) => (current === null ? current : null))
      return
    }

    const element = elements.find((candidate) => candidate.id === anchorId && !candidate.isDeleted)
    if (!element) {
      setDocsAnchor((current) => (current === null ? current : null))
      return
    }

    const [minX, minY, maxX, maxY] = getCommonBounds([element])
    const topLeft = sceneCoordsToViewportCoords({ sceneX: minX, sceneY: minY }, appState as any)
    const bottomRight = sceneCoordsToViewportCoords({ sceneX: maxX, sceneY: maxY }, appState as any)

    // sceneCoordsToViewportCoords returns page coordinates; the card is positioned
    // inside the canvas area, so the canvas offset comes back off again.
    const next = {
      rect: {
        x: topLeft.x - appState.offsetLeft,
        y: topLeft.y - appState.offsetTop,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y
      },
      viewport: { width: appState.width, height: appState.height },
      // While a shape is being dragged, resized or rotated, a card pinned to it would
      // chase the pointer. Excalidraw's own hyperlink popup hides for the same reason.
      suppressed: Boolean(
        appState.selectedElementsAreBeingDragged ||
        appState.isRotating ||
        appState.resizingElement ||
        appState.newElement
      )
    }

    // onChange fires on every pointer move; only re-render when something actually moved.
    setDocsAnchor((current) => {
      if (
        current &&
        current.rect.x === next.rect.x &&
        current.rect.y === next.rect.y &&
        current.rect.width === next.rect.width &&
        current.rect.height === next.rect.height &&
        current.viewport.width === next.viewport.width &&
        current.viewport.height === next.viewport.height &&
        current.suppressed === next.suppressed
      ) {
        return current
      }
      return next
    })
  }

  const applySceneUpdateWithoutAutoSync = (
    api: ExcalidrawImperativeAPI,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): void => {
    suppressAutoSyncCountRef.current += 1
    api.updateScene(scene)
    setTimeout(() => {
      suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
    }, 0)
  }

  // ─── The GitHub project mirror ──────────────────────────────
  //
  // A region on the left of the board showing the project's own columns, rebuilt from
  // GitHub rather than restored from a file. Everything it draws is marked
  // `customData.kind = "project-board"`, which is what keeps it out of the autosync and
  // out of the export: these shapes are derived, and a derived shape that gets saved
  // becomes a stale copy the next person has to reconcile by hand.

  /**
   * The last board read, where its columns landed, and which moves failed.
   *
   * A ref rather than state: it is read inside `onChange`, which fires on every pointer
   * move, and none of it belongs in a render.
   */
  const projectBoardRef = useRef<{
    board: ProjectBoard | null
    columns: MirrorColumn[]
    errors: Record<string, string>
    /** What is known about implementing each issue, by URL, as of the last refresh. */
    implementing: Record<string, CardImplementState>
    signature: string
  }>({ board: null, columns: [], errors: {}, implementing: {}, signature: '' })

  /** Whether a drag was in flight on the previous change, so its end can be noticed. */
  const mirrorDraggingRef = useRef<boolean>(false)

  /** The draft heights the mirror was last laid out for; a change is what re-slots it. */
  const draftGeometryRef = useRef<string>('')

  const clearMirror = (): void => {
    projectBoardRef.current = { board: null, columns: [], errors: {}, implementing: {}, signature: '' }
    draftGeometryRef.current = ''
    const api = excalidrawAPIRef.current
    if (!api) return
    const scene = api.getSceneElementsIncludingDeleted()
    const remaining = scene.filter((element) => !isMirrorElement(element))
    if (remaining.length === scene.length) return
    applySceneUpdateWithoutAutoSync(api, {
      elements: remaining,
      captureUpdate: CaptureUpdateAction.NEVER
    })
  }

  /**
   * Draw the mirror for a board that was just read.
   *
   * Anchored to the left of whatever else is on the canvas and recomputed every time, so
   * the region follows a board that grew rather than sitting at a coordinate somebody
   * once picked. Draft blocks are excluded from that measurement: they live *inside* the
   * mirror, and measuring against them would walk the region further left on every pass.
   */
  const renderMirror = (board: ProjectBoard): void => {
    const api = excalidrawAPIRef.current
    if (!api) return

    // Tombstones come along untouched. A deletion travels to the server as an element
    // marked deleted, and a redraw that quietly dropped one would undo it — the mirror
    // repaints on a timer, which is exactly when nobody would connect the two.
    const scene = api.getSceneElementsIncludingDeleted()
    const tombstones = scene.filter((element) => element.isDeleted && !isMirrorElement(element))
    const own = scene.filter((element) => !element.isDeleted && !isMirrorElement(element))
    const drafts = own.filter(isDraftBlock)
    // The terminal is left out of the measurement for the reason the drafts are: it is
    // placed *from* the board's own bounds, on the other side, so measuring against it
    // would walk the mirror further left every time the terminal moved right.
    const anchors = own.filter((element) => !isDraftBlock(element)
      && !isTerminalElement(element)
      && !(element.containerId && drafts.some((draft) => draft.id === element.containerId)))

    const width = boardWidth(board.sections.length)
    let origin = { x: -(width + MIRROR_GAP), y: 0 }
    if (anchors.length > 0) {
      const [minX, minY] = getCommonBounds(anchors as readonly NonDeletedExcalidrawElement[])
      origin = { x: minX - MIRROR_GAP - width, y: minY }
    }

    // The blocks the `+` dropped hold the top of their column, newest first, and the
    // mirrored cards start below them. Both halves of that arithmetic come from
    // `layoutBoard`, so the room reserved and the slot a block is put in cannot disagree.
    const layout = layoutBoard(board, origin, {
      errors: projectBoardRef.current.errors,
      implementing: projectBoardRef.current.implementing,
      drafts: drafts.map(draftBlockOf)
    })
    const placed = new Map(layout.drafts.map((placement) => [placement.id, placement]))

    // The block being typed into is left exactly where it is: rewriting a container and
    // its label out from under a caret is how an editor gets closed, or worse, corrupted.
    // Only that one, though — everything else in the column still makes room for it, and
    // the block itself does not need to move anyway, being already at the top and only
    // growing. It is re-slotted when the editor closes, which `frozen` in the signature is
    // what makes happen.
    const frozen = editingDraftId(api)

    const nextOwn = own.map((element) => {
      if (frozen && (element.id === frozen || element.containerId === frozen)) return element
      const slot = placed.get(element.containerId ?? '') ?? placed.get(element.id)
      if (!slot) return element
      // A label moves with its container, and keeps its own centring.
      const isLabel = Boolean(element.containerId)
      const container = isLabel ? drafts.find((draft) => draft.id === element.containerId) : element
      if (!container) return element
      return {
        ...element,
        x: isLabel ? slot.x + (slot.width - element.width) / 2 : slot.x,
        y: isLabel ? slot.y + (container.height - element.height) / 2 : slot.y,
        ...(isLabel ? {} : { width: slot.width })
      }
    })

    // `frozen` is part of the signature because it changes what gets written: the pass that
    // left a block alone must not let the one after the editor closed, which puts it back
    // in its slot, be skipped as "nothing moved".
    const signature = JSON.stringify([layout.elements, layout.drafts, frozen])
    if (signature === projectBoardRef.current.signature
        && scene.some((element) => isMirrorElement(element))) {
      // Nothing moved. Redrawing anyway would fight the reader's selection every poll.
      projectBoardRef.current = { ...projectBoardRef.current, board, columns: layout.columns }
      return
    }

    projectBoardRef.current = {
      ...projectBoardRef.current,
      board,
      columns: layout.columns,
      signature
    }

    applySceneUpdateWithoutAutoSync(api, {
      elements: [
        ...convertElementsPreservingImageProps([
          ...(nextOwn as unknown as Partial<ExcalidrawElement>[]),
          ...(layout.elements as unknown as Partial<ExcalidrawElement>[])
        ]),
        ...tombstones
      ] as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER
    })
  }

  /**
   * Drop the draft blocks whose issue now has a card of its own.
   *
   * Matched on the issue URL rather than on position or title: the URL is the only thing
   * the block and the card provably share. A run that failed leaves its block alone —
   * there is nothing to replace it with, and the observation is still worth keeping.
   */
  const reconcileDrafts = async (board: ProjectBoard): Promise<void> => {
    const api = excalidrawAPIRef.current
    if (!api) return

    const mirrored = new Set(
      board.sections.flatMap((section) => section.cards.map((card) => card.url).filter(Boolean))
    )
    const scene = api.getSceneElementsIncludingDeleted()
    const done = scene.filter((element) => {
      if (!isDraftBlock(element)) return false
      const url = customDataOf(element).issueUrl
      return typeof url === 'string' && mirrored.has(url)
    })
    if (done.length === 0) return

    const doomed = new Set(done.map((element) => element.id))
    for (const element of scene) {
      if (element.containerId && doomed.has(element.containerId)) doomed.add(element.id)
    }

    // Deleted on the server too: the sync never treats absence as a deletion, so a block
    // removed only from this scene would come straight back on the next connection.
    await Promise.all([...doomed].map((id) =>
      fetch(apiUrl(`/api/elements/${id}`), { method: 'DELETE' }).catch(() => undefined)))

    applySceneUpdateWithoutAutoSync(api, {
      elements: api.getSceneElementsIncludingDeleted().filter((element) => !doomed.has(element.id)),
      captureUpdate: CaptureUpdateAction.NEVER
    })
  }

  /**
   * Which issues have a run against them, by URL.
   *
   * Read alongside the board rather than from the cards, because a card cannot carry it:
   * the mirror redraws from GitHub on every poll, and the run record lives on the server
   * against the issue. It costs no `gh` — `GET /api/implement` reads the map and nothing
   * else — which is why it can ride the same twenty-second poll the board does.
   */
  const readImplementRecords = async (): Promise<Record<string, CardImplementState>> => {
    try {
      const response = await fetch(apiUrl('/api/implement'))
      if (!response.ok) return {}
      const body = await response.json().catch(() => ({}))
      const runs = Array.isArray(body?.runs) ? body.runs : []
      return Object.fromEntries(
        runs
          .filter((run: { issueUrl?: string; state?: string }) => Boolean(run?.issueUrl && run.state))
          .map((run: { issueUrl: string; state: CardImplementState }) => [run.issueUrl, run.state])
      )
    } catch {
      // A board that draws no run marks is worse than one that draws them; a board that
      // stops redrawing because this request failed is worse than both.
      return {}
    }
  }

  /** Re-read the project and redraw. A board with no project configured stays blank. */
  const refreshProjectBoard = async (): Promise<void> => {
    const api = excalidrawAPIRef.current
    if (!api) return

    // Never redraw under a pointer or a caret: rebuilding while a card is being dragged
    // or a label typed into would take the thing being worked on out from under it.
    const appState = api.getAppState() as unknown as Record<string, unknown>
    if (appState.selectedElementsAreBeingDragged || appState.editingTextElement
        || appState.newElement || appState.resizingElement) {
      return
    }

    const workspace = activeWorkspaceRef.current
    try {
      const response = await fetch(apiUrl('/api/project-board'))
      // A tab switched while the request was in flight would draw one project's board
      // over another project's canvas.
      if (activeWorkspaceRef.current !== workspace) return
      if (response.status === 404) {
        clearMirror()
        return
      }
      const body = await response.json().catch(() => ({}))
      if (!body?.success || !body.board) return
      await reconcileDrafts(body.board as ProjectBoard)
      if (activeWorkspaceRef.current !== workspace) return
      const implementing = await readImplementRecords()
      if (activeWorkspaceRef.current !== workspace) return
      projectBoardRef.current = { ...projectBoardRef.current, implementing }
      renderMirror(body.board as ProjectBoard)
    } catch (error) {
      console.warn('Could not read the project board:', error)
    }
  }

  /**
   * Write a dragged card's new column back to GitHub.
   *
   * A failure snaps the card back to where GitHub still says it is and writes the reason
   * onto it. The snap-back alone would be ambiguous — it reads like a drag that did not
   * take — so the message is what turns it into an error.
   */
  const moveMirrorCard = async (itemId: string, optionId: string): Promise<void> => {
    const previous = projectBoardRef.current.board
    try {
      const response = await fetch(apiUrl('/api/project-board/move'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, optionId })
      })
      const body = await response.json().catch(() => ({}))
      if (response.ok && body?.board) {
        const { [itemId]: _cleared, ...rest } = projectBoardRef.current.errors
        projectBoardRef.current = { ...projectBoardRef.current, errors: rest, signature: '' }
        renderMirror(body.board as ProjectBoard)
        return
      }
      projectBoardRef.current = {
        ...projectBoardRef.current,
        errors: { ...projectBoardRef.current.errors, [itemId]: body?.error ?? `HTTP ${response.status}` },
        signature: ''
      }
      if (previous) renderMirror(previous)
    } catch (error) {
      projectBoardRef.current = {
        ...projectBoardRef.current,
        errors: { ...projectBoardRef.current.errors, [itemId]: (error as Error).message },
        signature: ''
      }
      if (previous) renderMirror(previous)
    }
  }

  /**
   * Notice a card that was dropped somewhere else.
   *
   * On the *end* of a drag rather than during it: a card crosses columns on its way
   * anywhere, and writing every crossing back would rewrite the project several times
   * per gesture. Anything that did not land squarely in another column is put back where
   * GitHub says it belongs.
   */
  const settleMirrorDrag = (
    elements: readonly ExcalidrawElement[] | undefined,
    appState: Record<string, unknown> | undefined
  ): void => {
    const dragging = Boolean(appState?.selectedElementsAreBeingDragged)
    const wasDragging = mirrorDraggingRef.current
    mirrorDraggingRef.current = dragging
    if (dragging || !wasDragging) return

    const { board, columns } = projectBoardRef.current
    if (!board || columns.length === 0 || !elements) return

    let strayed = false
    for (const element of elements) {
      const custom = customDataOf(element)
      if (custom.kind !== MIRROR_KIND || custom.role !== 'card') continue

      const column = columnAt(columns, element.x + element.width / 2)
      if (column && column.optionId === custom.sectionOptionId) continue

      strayed = true
      if (column && custom.draggable === true && typeof custom.itemId === 'string') {
        void moveMirrorCard(custom.itemId, column.optionId)
        return
      }
    }

    // Dropped in a gap, or onto a column it cannot be moved to. Put it back.
    if (strayed) {
      projectBoardRef.current = { ...projectBoardRef.current, signature: '' }
      renderMirror(board)
    }
  }

  /**
   * Re-slot the mirror when a draft block changed height, or when one came or went.
   *
   * An Excalidraw container grows to fit the text bound to it, so a block gets taller with
   * every keystroke — and nothing was watching that. `refreshProjectBoard` runs on a
   * twenty-second poll and returns early under a caret, which is precisely when the block
   * is growing, so the cards below sat still and were overlapped until the editor was left
   * *and* the next poll came round.
   *
   * Off `projectBoardRef` rather than a fresh read: the heights are the only thing that
   * changed, and asking GitHub about them on every keystroke would be absurd.
   */
  const relayoutForDrafts = (
    elements: readonly ExcalidrawElement[] | undefined,
    appState: Record<string, unknown> | undefined
  ): void => {
    const board = projectBoardRef.current.board
    if (!board || !elements) return

    // Not mid-gesture: a drag or a resize is still being aimed, and a mirror that
    // rearranged itself under the pointer would move the target. The signature is left
    // alone so the relayout happens as soon as the gesture ends.
    if (appState?.selectedElementsAreBeingDragged || appState?.resizingElement
        || appState?.newElement) {
      return
    }

    // The editor being open is part of the signature: the block under the caret is the one
    // relayout leaves alone, so closing the editor is itself a reason to lay out again and
    // put it back in the slot the others made for it.
    const editing = (appState?.editingTextElement ?? null) as { id?: string; containerId?: string | null } | null
    const signature = [
      `editing:${editing ? String(editing.containerId ?? editing.id ?? '') : ''}`,
      ...elements
        .filter((element) => !element.isDeleted && isDraftBlock(element))
        .map((element) => `${element.id}@${Math.round(element.height)}#${customDataOf(element).sectionOptionId ?? ''}`)
    ].join('|')
    if (signature === draftGeometryRef.current) return
    draftGeometryRef.current = signature

    renderMirror(board)
  }

  /**
   * Drop an issue block at the top of a column.
   *
   * Only the first column, because that is the only one this can honestly create into:
   * the project's *Item added to project* workflow is what gives a new issue a status,
   * and it puts it in the first option. An item that arrives with none shows up in the
   * No Status section rather than vanishing.
   */
  const addIssueBlockToColumn = (sectionOptionId: string): void => {
    const api = excalidrawAPIRef.current
    const { board, columns } = projectBoardRef.current
    if (!api || !board) return

    const column = columns.find((candidate) => candidate.optionId === sectionOptionId) ?? columns[0]
    if (!column) return

    const template = findIssueBlockTemplate(libraryItems)
    if (!template) {
      console.warn('The library ships no issue block, so + has nothing to drop.')
      return
    }

    // `draftsTop`, not `cardsTop`: the block goes above every draft already in the column,
    // because it is the newest and that is where the newest goes. Dropping it at the card
    // top would land it under them and let it flash there before the redraw corrected it.
    const created = instantiateIssueBlock(
      template,
      { x: column.x, y: column.draftsTop, width: column.width },
      column.optionId,
      Date.now()
    )
    if (created.length === 0) return

    const shapeId = created[0]?.id as string
    // Not suppressed: this block is authored, not mirrored, and has to reach the server
    // the way any other shape the reader adds does.
    api.updateScene({
      elements: convertElementsPreservingImageProps([
        ...(api.getSceneElements() as unknown as Partial<ExcalidrawElement>[]),
        ...created
      ]) as ExcalidrawElement[],
      appState: { selectedElementIds: { [shapeId]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    })

    // Redraw so the cards below make room for the block that was just dropped on them.
    projectBoardRef.current = { ...projectBoardRef.current, signature: '' }
    renderMirror(board)
  }

  // ─── The terminal ───────────────────────────────────────────
  //
  // A block on the right of the board, mirroring the mirror: the project's own columns on
  // one side, a shell running in the project on the other. The shape is derived, like the
  // mirror's cards — it is rebuilt whenever a session is there to draw it, and it is stripped
  // before the autosync and before the export, because a saved terminal is a dead frame
  // around a session that has ended.

  interface TerminalStatus {
    cwd: string
    shell: string
    cols: number
    rows: number
  }

  const [terminal, setTerminal] = useState<{
    status: TerminalStatus | null
    output: string
    /** Why the block is inert, once it is: the shell exited, or the server refused. */
    ended: string | null
  }>({ status: null, output: '', ended: null })

  /**
   * Whether a session is open, for the paths that cannot read state.
   *
   * The WebSocket handlers are attached at mount and close over a scope where this is still
   * its initial value, and the scene-replacing paths run from inside them. Same reason
   * `activeWorkspaceRef` exists.
   */
  const terminalOpenRef = useRef<boolean>(false)

  const [terminalRect, setTerminalRect] = useState<{
    rect: Rect
    zoom: number
    suppressed: boolean
  } | null>(null)

  /** The grid last reported, so a pan or a re-render does not re-report the same size. */
  const terminalGridRef = useRef<string>('')
  const terminalResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Put the block on the board, if a session is open and it is not there already.
   *
   * Placed once and then left alone, unlike the mirror, which repaints on a timer: the
   * reader is expected to move and resize this one, and a redraw that re-anchored it every
   * twenty seconds would undo that. What does bring it back is a scene that was replaced
   * wholesale — a reload, a tab switch — and the hotkey, which is the way back from having
   * deleted it.
   */
  const ensureTerminalBlock = (options: { scroll?: boolean } = {}): void => {
    const api = excalidrawAPIRef.current
    if (!api || !terminalOpenRef.current) return

    const scene = api.getSceneElementsIncludingDeleted()
    const existing = scene.find((element) => !element.isDeleted && isTerminalElement(element))
    if (existing) {
      if (options.scroll) {
        api.scrollToContent([existing] as unknown as ExcalidrawElement[], { fitToViewport: true, animate: true })
      }
      return
    }

    // "The right side" measured against what this board authored, which is neither the
    // mirror on the left nor a terminal block that is on its way out.
    const anchors = scene.filter((element) => !element.isDeleted && !isDerivedElement(element))
    const bounds = anchors.length > 0
      ? (() => {
        const [minX, minY, maxX, maxY] = getCommonBounds(anchors as readonly NonDeletedExcalidrawElement[])
        return { minX, minY, maxX, maxY }
      })()
      : null

    const block = terminalBlockElement(terminalOrigin(bounds), TERMINAL_SIZE)
    applySceneUpdateWithoutAutoSync(api, {
      elements: convertElementsPreservingImageProps([
        ...(scene as unknown as Partial<ExcalidrawElement>[]),
        block as unknown as Partial<ExcalidrawElement>
      ]) as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER
    })

    if (options.scroll) {
      const placed = api.getSceneElements().filter((element) => isTerminalElement(element))
      if (placed.length > 0) {
        api.scrollToContent(placed as unknown as ExcalidrawElement[], { fitToViewport: true, animate: true })
      }
    }
  }

  /**
   * Open a session for the active board, or adopt the one that is already running.
   *
   * 409 is not a failure here: a reload, a second window or a tab switched away and back
   * all arrive at a server that still owns the shell, and the right answer to "there is
   * already one" is to draw it rather than to start another. 404 and 403 are the guards —
   * the feature is off, or the server is reachable from the network — and both mean no
   * block at all.
   */
  const openTerminal = async (): Promise<void> => {
    try {
      const response = await fetch(apiUrl('/api/terminal'), { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok && response.status !== 409) {
        terminalOpenRef.current = false
        setTerminal({ status: null, output: '', ended: null })
        return
      }

      const session = body?.session ?? null
      // A session that was already running has a transcript, and the socket only replays it
      // on connect — which for this tab already happened. Read once, and only in that case:
      // a session that has just started has nothing to catch up on.
      const caught = response.status === 409
        ? await fetch(apiUrl('/api/terminal')).then((r) => r.json()).catch(() => null)
        : null
      terminalOpenRef.current = true
      setTerminal({
        status: session
          ? { cwd: session.cwd, shell: session.shell, cols: session.cols, rows: session.rows }
          : null,
        output: typeof caught?.scrollback === 'string' ? caught.scrollback : '',
        ended: null
      })
      ensureTerminalBlock()
    } catch (error) {
      console.warn('Could not open a terminal:', error)
    }
  }

  /** Send one line to the shell. The echo comes back over the socket, like any other output. */
  const sendTerminalInput = (line: string): void => {
    void fetch(apiUrl('/api/terminal/input'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: `${line}\n` })
    }).catch((error) => console.warn('Could not send to the terminal:', error))
  }

  /**
   * Follow the block: where it is on screen, and what size it now stands for.
   *
   * The rect is in viewport coordinates, the same arithmetic the documentation card uses,
   * so the overlay pans and zooms with the shape. The grid is in *scene* units, so a pinch
   * is not a resize — what the reader resized is the block, and that is what the server is
   * told about.
   */
  const syncTerminalBlock = (
    elements: readonly ExcalidrawElement[] | undefined,
    appState: Record<string, any> | undefined
  ): void => {
    if (!appState || !elements || !terminalOpenRef.current) {
      setTerminalRect((current) => (current === null ? current : null))
      return
    }

    const element = elements.find((candidate) => !candidate.isDeleted && isTerminalElement(candidate))
    if (!element) {
      setTerminalRect((current) => (current === null ? current : null))
      return
    }

    const [minX, minY, maxX, maxY] = getCommonBounds([element])
    const topLeft = sceneCoordsToViewportCoords({ sceneX: minX, sceneY: minY }, appState as any)
    const bottomRight = sceneCoordsToViewportCoords({ sceneX: maxX, sceneY: maxY }, appState as any)
    const next = {
      rect: {
        x: topLeft.x - appState.offsetLeft,
        y: topLeft.y - appState.offsetTop,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y
      },
      zoom: appState.zoom?.value ?? 1,
      // Hidden mid-gesture, the way the documentation card is: a DOM overlay lags a shape
      // being dragged by a frame, which reads as the terminal coming loose from its block.
      suppressed: Boolean(
        appState.selectedElementsAreBeingDragged ||
        appState.isRotating ||
        appState.resizingElement
      )
    }

    setTerminalRect((current) => {
      if (
        current &&
        current.rect.x === next.rect.x &&
        current.rect.y === next.rect.y &&
        current.rect.width === next.rect.width &&
        current.rect.height === next.rect.height &&
        current.zoom === next.zoom &&
        current.suppressed === next.suppressed
      ) {
        return current
      }
      return next
    })

    // Reported on the end of the gesture rather than during it: a resize crosses every size
    // between where it started and where it lands, and reporting each one would be a
    // request per frame.
    const grid = terminalGrid({ width: element.width, height: element.height })
    const signature = `${grid.cols}x${grid.rows}`
    if (signature === terminalGridRef.current) return
    terminalGridRef.current = signature
    if (terminalResizeTimerRef.current) clearTimeout(terminalResizeTimerRef.current)
    terminalResizeTimerRef.current = setTimeout(() => {
      terminalResizeTimerRef.current = null
      void fetch(apiUrl('/api/terminal/resize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(grid)
      }).catch(() => undefined)
    }, TERMINAL_RESIZE_DEBOUNCE_MS)
  }

  // One session per board, opened when the board is shown. Nothing is closed on the way
  // out: a terminal you switched away from keeps its shell and its transcript, and the
  // server closes every session when it goes down.
  useEffect(() => {
    if (!excalidrawAPI) return
    terminalOpenRef.current = false
    terminalGridRef.current = ''
    setTerminal({ status: null, output: '', ended: null })
    setTerminalRect(null)
    void openTerminal()
  }, [activeWorkspace, excalidrawAPI])

  useEffect(() => {
    return () => {
      if (terminalResizeTimerRef.current) clearTimeout(terminalResizeTimerRef.current)
    }
  }, [])

  // On `window`, for the reason Alt+B is: Excalidraw never sees a key pressed outside its
  // canvas, and the point of this one is to work from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== TERMINAL_HOTKEY_CODE || !event.altKey || event.ctrlKey || event.metaKey) return
      if (!terminalOpenRef.current) return

      // A text field owns the keyboard — including this feature's own prompt, where Alt+T
      // has to be a keystroke rather than a jump.
      const active = document.activeElement as HTMLElement | null
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) {
        return
      }

      const api = excalidrawAPIRef.current
      if (!api) return
      if ((api.getAppState() as unknown as Record<string, unknown>).editingTextElement) return

      event.preventDefault()
      ensureTerminalBlock({ scroll: true })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
      }
    }
  }, [])

  // Polled while the tab is on screen. A background tab spawning a `gh` process every
  // twenty seconds is pure cost: nobody is looking at the answer.
  useEffect(() => {
    if (!excalidrawAPI) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (document.visibilityState === 'visible') await refreshProjectBoard()
      if (!cancelled) timer = setTimeout(() => { void tick() }, PROJECT_BOARD_POLL_MS)
    }
    void tick()

    const onVisible = (): void => { if (document.visibilityState === 'visible') void refreshProjectBoard() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [activeWorkspace, excalidrawAPI])

  // On `window`, because Excalidraw never sees a key pressed outside its canvas, and the
  // point of this one is to work from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== MIRROR_HOTKEY_CODE || !event.altKey || event.ctrlKey || event.metaKey) return

      // A label being typed into owns the keyboard. Excalidraw edits text in a real
      // textarea, so what has focus is the honest test — and it is the one that keeps
      // this from swallowing a keystroke meant for a card's title.
      const active = document.activeElement as HTMLElement | null
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) {
        return
      }

      const api = excalidrawAPIRef.current
      if (!api) return
      if ((api.getAppState() as unknown as Record<string, unknown>).editingTextElement) return

      const mirror = api.getSceneElements().filter((element) => isMirrorElement(element))
      if (mirror.length === 0) return

      event.preventDefault()
      api.scrollToContent(mirror as unknown as ExcalidrawElement[], {
        fitToViewport: true,
        animate: true
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // WebSocket connection
  useEffect(() => {
    connectWebSocket()
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close()
      }
    }
  }, [])

  // Load existing elements when Excalidraw API becomes available
  useEffect(() => {
    if (excalidrawAPI) {
      loadExistingElements()

      // Ensure WebSocket is connected for real-time updates
      if (!isConnected) {
        connectWebSocket()
      }
    }
  }, [excalidrawAPI, isConnected])

  useEffect(() => {
    let cancelled = false
    fetch('/api/workspaces')
      .then((response) => response.json())
      .then((result) => {
        if (cancelled || !result?.success) return
        const list: WorkspaceSummary[] = result.workspaces ?? []
        setWorkspaces(list)
        // The socket opens before this response lands, so it is already watching the
        // default board. Switching rather than assigning reconnects it, otherwise the
        // first tab would render highlighted while showing the default board's scene.
        // With no registry the server keeps using its default store, so leave the
        // active id alone rather than inventing a workspace that does not exist.
        if (list.length > 0 && list[0]) {
          switchWorkspace(list[0].id)
        }
      })
      .catch((error) => console.warn('Could not load workspaces:', error))
    return () => { cancelled = true }
  }, [])

  /**
   * Switch boards.
   *
   * The scene is emptied before reconnecting: the new board's elements arrive
   * asynchronously, and leaving the old ones on screen until they do would show one
   * project's shapes under another project's tab.
   */
  const switchWorkspace = (workspaceId: string): void => {
    if (workspaceId === activeWorkspaceRef.current) return

    activeWorkspaceRef.current = workspaceId
    setActiveWorkspace(workspaceId)
    // Everything the panel holds, not just the document: switching boards with an issue
    // block selected would otherwise leave its card open over the new board.
    setSelectedDoc({ key: null, title: null })
    setIssue(null)
    setCollapsible(null)
    docsAnchorIdRef.current = null
    setDismissedAnchorId(null)
    lastSelectedIdRef.current = null
    // The mirror belongs to one project. Keeping the last board would let a stale set of
    // columns decide where a card dragged on the new board was dropped.
    projectBoardRef.current = { board: null, columns: [], errors: {}, implementing: {}, signature: '' }

    if (excalidrawAPI) {
      applySceneUpdateWithoutAutoSync(excalidrawAPI, {
        elements: [],
        captureUpdate: CaptureUpdateAction.NEVER
      })
    }

    // A socket belongs to one board for its lifetime, so switching means reconnecting.
    if (websocketRef.current) {
      websocketRef.current.onclose = null
      websocketRef.current.close()
      websocketRef.current = null
    }
    setIsConnected(false)
    connectWebSocket()
  }

  // Reloaded per board: a project may ship its own shapes on top of the shared set.
  useEffect(() => {
    let cancelled = false
    fetch(apiUrl('/api/library'))
      .then((response) => response.json())
      .then((result) => {
        if (cancelled || !result?.success) return
        const items = result.libraryItems ?? []
        setLibraryItems(items)
        // merge: false so a board never inherits the previous board's shapes.
        excalidrawAPI?.updateLibrary({ libraryItems: items, merge: false })
        if (result.errors?.length) console.warn('Library:', result.errors.join('; '))
      })
      .catch((error) => console.warn('Could not load library:', error))
    return () => { cancelled = true }
  }, [activeWorkspace, excalidrawAPI])

  /**
   * Re-read panel state from an element that changed underneath us.
   *
   * Only for the shape currently on screen: refreshing for any element would let a
   * background update hijack the panel away from what the user has selected.
   */
  const refreshPanelStateFrom = (updated: { id: string; customData?: unknown }): void => {
    if (updated.id !== lastSelectedIdRef.current) return
    const custom = (updated.customData ?? {}) as Record<string, unknown>

    if (custom.kind === 'issue') {
      setIssue({
        id: updated.id,
        state: (custom.issueState as IssueTarget['state']) ?? 'draft',
        issueUrl: (custom.issueUrl as string) ?? null,
        issueError: (custom.issueError as string) ?? null,
        issueTitle: (custom.issueTitle as string) ?? null,
        observation: (custom.observation as string) ?? null,
        images: Array.isArray(custom.issueImages) ? (custom.issueImages as string[]) : [],
        implementState: (custom.implementState as IssueTarget['implementState']) ?? null,
        implementUrl: (custom.implementUrl as string) ?? null,
        implementError: (custom.implementError as string) ?? null
      })
    }

    if (typeof custom.collapsed === 'boolean') {
      setCollapsible({ id: updated.id, collapsed: custom.collapsed })
    }
  }

  const loadExistingElements = async (): Promise<void> => {
    try {
      const response = await fetch(apiUrl('/api/elements'))
      const result: ApiResponse = await response.json()

      if (result.success && result.elements && result.elements.length > 0) {
        const cleanedElements = result.elements.map(cleanElementForExcalidraw)
        const convertedElements = convertElementsPreservingImageProps(cleanedElements)
        if (excalidrawAPI) {
          applySceneUpdateWithoutAutoSync(excalidrawAPI, {
            elements: convertedElements,
            captureUpdate: CaptureUpdateAction.NEVER
          })
          // The store holds no terminal block — it is derived and never synced — and this
          // just replaced the scene with what the store holds.
          ensureTerminalBlock()
        }
      }

      const filesResponse = await fetch('/api/files')
      if (filesResponse.ok) {
        const filesResult = await filesResponse.json() as ApiResponse
        if (filesResult.files) {
          excalidrawAPI?.addFiles(Object.values(filesResult.files))
        }
      }
    } catch (error) {
      console.error('Error loading existing elements:', error)
    }
  }

  const connectWebSocket = (): void => {
    // Guard CONNECTING too: the mount effect and the excalidrawAPI effect can
    // both run before the first socket opens, orphaning a live duplicate
    // connection whose handlers then process every broadcast twice.
    if (websocketRef.current &&
        (websocketRef.current.readyState === WebSocket.CONNECTING ||
         websocketRef.current.readyState === WebSocket.OPEN)) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // The socket declares its board once: the server then filters events to it, so a
    // tab never redraws with another board's shapes.
    const wsUrl = `${protocol}//${window.location.host}?workspace=${encodeURIComponent(activeWorkspaceRef.current)}`

    websocketRef.current = new WebSocket(wsUrl)

    websocketRef.current.onopen = () => {
      setIsConnected(true)

      if (excalidrawAPI) {
        setTimeout(loadExistingElements, 100)
      }
    }

    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }

    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false)

      // Reconnect after 3 seconds if not a clean close
      if (event.code !== 1000) {
        setTimeout(connectWebSocket, 3000)
      }
    }

    websocketRef.current.onerror = (error: Event) => {
      console.error('WebSocket error:', error)
      setIsConnected(false)
    }
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    const excalidrawAPI = excalidrawAPIRef.current
    if (!excalidrawAPI) {
      return
    }

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      const mergeAndApplySceneElements = (incomingElements: Partial<ExcalidrawElement>[]): void => {
        if (incomingElements.length === 0) return

        const incomingById = new Map<string, Partial<ExcalidrawElement>>()
        incomingElements.forEach((element) => {
          if (element.id) {
            incomingById.set(element.id, element)
          }
        })

        const mergedElements: Partial<ExcalidrawElement>[] = currentElements.map((element) => {
          const incoming = incomingById.get(element.id)
          if (!incoming) return element
          incomingById.delete(element.id)
          return { ...element, ...incoming }
        })

        mergedElements.push(...incomingById.values())

        const convertedElements = convertElementsPreservingImageProps(mergedElements)
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: convertedElements,
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }

      switch (data.type) {
        case 'initial_elements':
          if (data.elements && data.elements.length > 0) {
            const cleanedElements = data.elements.map(cleanElementForExcalidraw)
            const convertedElements = convertElementsPreservingImageProps(cleanedElements)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: convertedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          // Load files for image elements
          if ((data as any).files) {
            excalidrawAPI.addFiles(Object.values((data as any).files))
          }
          // The scene was just replaced wholesale, and the terminal's block is derived, so
          // the store this arrived from has never heard of it. Put it back.
          ensureTerminalBlock()
          break

        case 'files_added':
          if (Array.isArray((data as any).files)) {
            excalidrawAPI.addFiles((data as any).files)
          }
          break

        case 'element_created':
          if (data.element) {
            const cleanedNewElement = cleanElementForExcalidraw(data.element)
            // Rebuild against full scene so text/container bindings remain intact.
            mergeAndApplySceneElements([cleanedNewElement])
          }
          break

        case 'element_updated':
          if (data.element) {
            const cleanedUpdatedElement = cleanElementForExcalidraw(data.element)
            // Convert with full scene context so text metrics/container placement can refresh.
            mergeAndApplySceneElements([cleanedUpdatedElement])
            // The panel reads a shape's state when it is selected, so a block that
            // finishes while its panel is open would keep claiming to be running.
            // An issue run is the case that matters: it is the one that takes minutes.
            refreshPanelStateFrom(data.element)

            // A run that just ended is the one moment the project changed for a reason
            // this canvas knows about, so it need not wait out a poll interval.
            const finished = (data.element.customData ?? {}) as Record<string, unknown>
            if (finished.kind === 'issue'
                && (finished.issueState === 'created' || finished.issueState === 'failed')) {
              void refreshProjectBoard()
            }
          }
          break

        case 'element_deleted':
          if (data.elementId) {
            const filteredElements = currentElements.filter(el => el.id !== data.elementId)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: filteredElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break

        case 'elements_batch_created':
          if (data.elements) {
            const cleanedBatchElements = data.elements.map(cleanElementForExcalidraw)
            mergeAndApplySceneElements(cleanedBatchElements)
          }
          break

        case 'elements_synced':
          console.log(`Sync confirmed by server: ${data.count} elements`)
          // Sync confirmation already handled by HTTP response
          break

        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break

        case 'canvas_cleared':
          console.log('Canvas cleared by server')
          applySceneUpdateWithoutAutoSync(excalidrawAPI, {
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          break

        case 'export_image_request':
          if (data.requestId) {
            try {
              const elements = excalidrawAPI.getSceneElements()
              const appState = excalidrawAPI.getAppState()
              const files = excalidrawAPI.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await fetch('/api/export/image/result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: 'svg',
                    data: svgString
                  })
                })
              } else {
                const blob = await exportToBlob({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files,
                  mimeType: 'image/png'
                })
                const reader = new FileReader()
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string
                    const base64 = resultString?.split(',')[1]
                    if (!base64) {
                      throw new Error('Could not extract base64 data from result')
                    }
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message
                      })
                    }).catch(() => { })
                  }
                }
                reader.onerror = async () => {
                  console.error('FileReader error:', reader.error)
                  await fetch('/api/export/image/result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || 'FileReader failed'
                    })
                  }).catch(() => { })
                }
                reader.readAsDataURL(blob)
              }
            } catch (exportError) {
              console.error('Image export failed:', exportError)
              await fetch('/api/export/image/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (exportError as Error).message
                })
              })
            }
          }
          break

        case 'set_viewport':
          console.log('Received viewport control request', data)
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = excalidrawAPI.getSceneElements()
                if (allElements.length > 0) {
                  excalidrawAPI.scrollToContent(allElements, {
                    fitToViewport: true,
                    viewportZoomFactor: data.viewportZoomFactor,
                    animate: true
                  })
                }
              } else if (data.scrollToElementIds !== undefined) {
                if (!Array.isArray(data.scrollToElementIds) ||
                    data.scrollToElementIds.length === 0 ||
                    !data.scrollToElementIds.every(id => typeof id === 'string' && id.length > 0)) {
                  throw new Error('scrollToElementIds must be a non-empty array of element IDs')
                }
                const allElements = excalidrawAPI.getSceneElements()
                const requestedIds = new Set(data.scrollToElementIds)
                const targetElements = allElements.filter(el => requestedIds.has(el.id))
                const foundIds = new Set(targetElements.map(el => el.id))
                const missingIds = data.scrollToElementIds.filter(id => !foundIds.has(id))
                if (missingIds.length > 0) {
                  throw new Error(`Elements not found for IDs: ${missingIds.join(', ')}`)
                }
                excalidrawAPI.scrollToContent(targetElements, {
                  fitToViewport: true,
                  viewportZoomFactor: data.viewportZoomFactor,
                  animate: true
                })
              } else if (data.scrollToElementId) {
                const allElements = excalidrawAPI.getSceneElements()
                const targetElement = allElements.find(el => el.id === data.scrollToElementId)
                if (targetElement) {
                  excalidrawAPI.scrollToContent([targetElement], { fitToViewport: false, animate: true })
                } else {
                  throw new Error(`Element ${data.scrollToElementId} not found`)
                }
              } else {
                // Direct zoom/scroll control
                const appState: any = {}
                if (data.zoom !== undefined) {
                  appState.zoom = { value: data.zoom }
                }
                if (data.offsetX !== undefined) {
                  appState.scrollX = data.offsetX
                }
                if (data.offsetY !== undefined) {
                  appState.scrollY = data.offsetY
                }
                if (Object.keys(appState).length > 0) {
                  applySceneUpdateWithoutAutoSync(excalidrawAPI, { appState })
                }
              }

              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  success: true,
                  message: 'Viewport updated'
                })
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message
                })
              }).catch(() => { })
            }
          }
          break

        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                // Regenerate ids so repeated conversions of the same diagram
                // (mermaid emits stable ids like "A", "B") can't collide with
                // elements already on the canvas.
                const convertedElements = convertToExcalidrawElements(result.elements, { regenerateIds: true })
                // Merge with the existing scene — updateScene() replaces the
                // element list wholesale, and syncToBackend() would otherwise
                // propagate that wipe to the server.
                applySceneUpdateWithoutAutoSync(excalidrawAPI, {
                  elements: [...excalidrawAPI.getSceneElements(), ...convertedElements],
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) {
                  excalidrawAPI.addFiles(Object.values(result.files))
                }

                console.log('Mermaid diagram converted successfully:', result.elements.length, 'elements')

                // Sync to backend automatically after creating elements
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break

        // ─── The terminal ────────────────────────────────────
        //
        // The only messages here that carry bytes rather than shapes. They are per-board,
        // like every element event, because a shell belongs to one project.

        case 'terminal_session': {
          const session = (data as any).session ?? null
          terminalOpenRef.current = Boolean(session)
          setTerminal({
            status: session
              ? { cwd: session.cwd, shell: session.shell, cols: session.cols, rows: session.rows }
              : null,
            // The replay, whole: this arrives on connect for a session that was already
            // running, so it is a transcript rather than an increment.
            output: typeof (data as any).scrollback === 'string' ? (data as any).scrollback : '',
            ended: null
          })
          ensureTerminalBlock()
          break
        }

        case 'terminal_output':
          setTerminal((current) => (
            current.status === null
              ? current
              : { ...current, output: `${current.output}${(data as any).data ?? ''}` }
          ))
          break

        case 'terminal_resized':
          setTerminal((current) => (
            current.status === null
              ? current
              : {
                ...current,
                status: {
                  ...current.status,
                  cols: (data as any).cols ?? current.status.cols,
                  rows: (data as any).rows ?? current.status.rows
                }
              }
          ))
          break

        case 'terminal_exit':
          // The block stays on the board and says what happened. Removing it would answer
          // a shell that exited by taking the evidence away.
          setTerminal((current) => ({
            ...current,
            ended: `the shell exited${(data as any).code === null || (data as any).code === undefined
              ? ''
              : ` with code ${(data as any).code}`}`
          }))
          break

        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
    }
  }

  // Data format conversion for backend
  const convertToBackendFormat = (element: ExcalidrawElement): ServerElement => {
    return {
      ...element
    } as ServerElement
  }

  // Format sync time display
  const formatSyncTime = (time: Date | null): string => {
    if (!time) return ''
    return time.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  // Main sync function
  const syncToBackend = async (options: { silent?: boolean } = {}): Promise<void> => {
    const { silent = false } = options

    // Read through the ref: WS message handlers attached at mount capture a
    // stale closure where the excalidrawAPI state is still null.
    const api = excalidrawAPIRef.current
    if (!api) {
      console.warn('Excalidraw API not available')
      return
    }

    if (syncInFlightRef.current) {
      return
    }

    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }

    syncInFlightRef.current = true
    if (!silent) {
      setSyncStatus('syncing')
    }

    try {
      // 1. Get current elements, deleted ones included. The backend reconciles by
      // version and never treats absence as a deletion, so tombstones have to travel
      // explicitly — otherwise deleting a shape here would leave it alive there.
      // The project mirror is derived from GitHub and rebuilt from it, and the terminal's
      // block exists for as long as its shell does, so neither is this board's to save.
      // Left in, they would be stored, re-sent on every connection and exported into the
      // committed board file — a stale copy of something that already has one authority.
      //
      // A label bound to one goes with it. Excalidraw offers to bind text to any selected
      // shape — the hint says so, on the terminal block as on anything else — and that label
      // carries no `kind` of its own, so on its own terms it looks authored. Stored, it
      // would be a text element whose container the store has never heard of.
      const scene = api.getSceneElementsIncludingDeleted()
      const derivedIds = new Set(scene.filter(isDerivedElement).map((element) => element.id))
      const currentElements = scene.filter((element) => !isDerivedElement(element)
        && !(element.containerId && derivedIds.has(element.containerId)))
      console.log(`Syncing ${currentElements.length} elements to backend`)

      // 3. Convert to backend format
      const backendElements = currentElements.map(convertToBackendFormat)

      // 4. Send to backend
      const response = await fetch(apiUrl('/api/elements/sync'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          elements: backendElements,
          timestamp: new Date().toISOString()
        })
      })

      if (response.ok) {
        const result: ApiResponse = await response.json()
        setLastSyncTime(new Date())
        console.log(`Sync successful: ${result.count} elements synced`)

        if (!silent) {
          setSyncStatus('success')
          // Reset status after 2 seconds
          setTimeout(() => setSyncStatus('idle'), 2000)
        }
      } else {
        const error: ApiResponse = await response.json()
        console.error('Sync failed:', error.error)
        if (!silent) {
          setSyncStatus('error')
        }
      }
    } catch (error) {
      console.error('Sync error:', error)
      if (!silent) {
        setSyncStatus('error')
      }
    } finally {
      syncInFlightRef.current = false
    }
  }

  const scheduleAutoSync = (): void => {
    if (!isConnected || !excalidrawAPI) {
      return
    }
    if (!userInteractedRef.current) {
      return
    }
    if (suppressAutoSyncCountRef.current > 0) {
      return
    }
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
    }

    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null
      if (suppressAutoSyncCountRef.current > 0 || syncInFlightRef.current) {
        return
      }
      void syncToBackend({ silent: true })
    }, AUTO_SYNC_DEBOUNCE_MS)
  }

  const clearCanvas = async (): Promise<void> => {
    if (excalidrawAPI) {
      try {
        // Get all current elements and delete them from backend
        const response = await fetch(apiUrl('/api/elements'))
        const result: ApiResponse = await response.json()

        if (result.success && result.elements) {
          const deletePromises = result.elements.map(element =>
            fetch(apiUrl(`/api/elements/${element.id}`), { method: 'DELETE' })
          )
          await Promise.all(deletePromises)
        }

        // Clear the frontend canvas
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      } catch (error) {
        console.error('Error clearing canvas:', error)
        // Still clear frontend even if backend fails
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      }
    }
  }

  return (
    <div className="app" data-theme={theme}>
      <WorkspaceTabs
        workspaces={workspaces}
        activeId={activeWorkspace}
        onSelect={switchWorkspace}
      />

      {/* Header */}
      <div className="header">
        <h1>Excalidraw Canvas</h1>
        <div className="controls">
          <div className="status">
            <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`}></div>
            <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>

          {/* Sync Controls */}
          <div className="sync-controls">
            <button
              className={`btn-primary ${syncStatus === 'syncing' ? 'btn-loading' : ''}`}
              onClick={syncToBackend}
              disabled={syncStatus === 'syncing' || !excalidrawAPI}
            >
              {syncStatus === 'syncing' && <span className="spinner"></span>}
              {syncStatus === 'syncing' ? 'Syncing...' : 'Sync to Backend'}
            </button>

            {/* Sync Status */}
            <div className="sync-status">
              {syncStatus === 'success' && (
                <span className="sync-success">✅ Synced</span>
              )}
              {syncStatus === 'error' && (
                <span className="sync-error">❌ Sync Failed</span>
              )}
              {lastSyncTime && syncStatus === 'idle' && (
                <span className="sync-time">
                  Last sync: {formatSyncTime(lastSyncTime)}
                </span>
              )}
            </div>
          </div>

          <button className="btn-secondary" onClick={clearCanvas}>Clear Canvas</button>
        </div>
      </div>

      {/* Canvas Container */}
      <div className="canvas-container">
        <div
          onPointerDownCapture={() => {
            userInteractedRef.current = true
          }}
          onKeyDownCapture={() => {
            userInteractedRef.current = true
          }}
          // Relative so the card's absolute position is measured from the canvas area,
          // which is the box its placement was computed against.
          style={{ width: '100%', height: '100%', position: 'relative' }}
        >
          <Excalidraw
            excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
            onChange={(_elements, appState) => {
              if (appState?.theme && appState.theme !== theme) {
                setTheme(appState.theme)
                try {
                  window.localStorage?.setItem('excalidraw-canvas-theme', appState.theme)
                } catch (error) {
                  console.warn('Failed to save theme to localStorage:', error)
                }
              }
              syncSelectedDoc(appState)
              // Order matters: syncSelectedDoc settles which shape is anchored, and this
              // then works out where that shape is.
              syncDocsAnchor(_elements, appState as unknown as Record<string, any>)
              // Same arithmetic, its own overlay: the terminal follows its block wherever
              // the board is panned, zoomed or the shape dragged to.
              syncTerminalBlock(_elements, appState as unknown as Record<string, any>)
              settleMirrorDrag(_elements, appState as unknown as Record<string, unknown>)
              // After settling a drag, so a card that just changed column is not re-slotted
              // against the board it is about to leave.
              relayoutForDrafts(_elements, appState as unknown as Record<string, unknown>)
              scheduleAutoSync()
            }}
            initialData={{
              elements: [],
              appState: {
                theme
              }
            }}
          />

          {/* A sibling of the canvas, not a child of it: the card is a DOM overlay, so
              it never becomes a scene element and never reaches a PNG or SVG export. */}
          <AnchoredDocsPanel
            anchor={
              docsAnchor && docsAnchorIdRef.current !== dismissedAnchorId
                ? docsAnchor.rect
                : null
            }
            viewport={docsAnchor?.viewport ?? { width: 0, height: 0 }}
            suppressed={docsAnchor?.suppressed ?? false}
            onClose={() => setDismissedAnchorId(docsAnchorIdRef.current)}
            docKey={selectedDoc.key}
            title={selectedDoc.title}
            workspace={activeWorkspace}
            collapsible={collapsible}
            onToggleCollapse={toggleImageCollapse}
            issue={issue}
            onCreateIssue={createIssueFromBlock}
            onAttachImages={attachIssueImages}
            onDetachImage={detachIssueImage}
            onImplementIssue={implementIssueFromBlock}
            onResetImplement={resetImplementOnBlock}
            onResetIssue={resetIssueOnBlock}
            onAddComment={addObservationToIssue}
          />

          {/* Also a sibling of the canvas, and for the same reason: the transcript is not a
              scene element, so it cannot be exported, synced or committed. */}
          <TerminalPanel
            rect={terminalRect?.rect ?? null}
            zoom={terminalRect?.zoom ?? 1}
            suppressed={terminalRect?.suppressed ?? false}
            output={terminal.output}
            status={terminal.status}
            ended={terminal.ended}
            onSubmit={sendTerminalInput}
          />
        </div>
      </div>
    </div>
  )
}

export default App
