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
import { CollapsibleTarget, IssueTarget } from './components/DocsPanel'
import { AnchoredDocsPanel } from './components/AnchoredDocsPanel'
import type { Rect } from '../../src/core/anchored-placement'
import { resolvePanelTarget } from '../../src/core/panel-target'
import type { PanelElement } from '../../src/core/panel-target'
import { layoutLabel } from '../../src/core/text-layout'
import {
  layoutBoard,
  boardWidth,
  columnAt,
  MIRROR_KIND,
  CARD_GAP
} from '../../src/core/project-board-layout'
import type { MirrorColumn } from '../../src/core/project-board-layout'
import type { ProjectBoard } from '../../src/core/project-board-types'
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

type CustomData = Record<string, unknown> | null | undefined;

const customDataOf = (element: { customData?: CustomData } | undefined): Record<string, unknown> =>
  (element?.customData ?? {}) as Record<string, unknown>;

/** Elements the mirror owns. Everything else on the canvas is the board's own drawing. */
const isMirrorElement = (element: { customData?: CustomData }): boolean =>
  customDataOf(element).kind === MIRROR_KIND;

/**
 * A block the `+` dropped, waiting for its run to produce a real card.
 *
 * Authored rather than mirrored: it is a real issue block, it persists, and it is the
 * user's until the issue exists. Only the container is marked, so counting drafts cannot
 * count a label twice.
 */
const isDraftBlock = (element: { customData?: CustomData; containerId?: string | null }): boolean =>
  customDataOf(element).projectBoardDraft === true && !element.containerId;

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
  seed: string
): Partial<ExcalidrawElement>[] => {
  const shape = template.find((element) => element?.customData?.kind === 'issue')
  if (!shape) return []

  const shapeId = `pbdraft-${seed}`
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
      sectionOptionId
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
      return `${tooBig.name} is larger than ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MB.`
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
    signature: string
  }>({ board: null, columns: [], errors: {}, signature: '' })

  /** Whether a drag was in flight on the previous change, so its end can be noticed. */
  const mirrorDraggingRef = useRef<boolean>(false)

  const clearMirror = (): void => {
    projectBoardRef.current = { board: null, columns: [], errors: {}, signature: '' }
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
    const anchors = own.filter((element) => !isDraftBlock(element)
      && !(element.containerId && drafts.some((draft) => draft.id === element.containerId)))

    const width = boardWidth(board.sections.length)
    let origin = { x: -(width + MIRROR_GAP), y: 0 }
    if (anchors.length > 0) {
      const [minX, minY] = getCommonBounds(anchors as readonly NonDeletedExcalidrawElement[])
      origin = { x: minX - MIRROR_GAP - width, y: minY }
    }

    // Room at the top of a column for the blocks the `+` dropped there, so a mirrored
    // card cannot land on one.
    const reservedTop: Record<string, number> = {}
    for (const draft of drafts) {
      const column = String(customDataOf(draft).sectionOptionId ?? '')
      reservedTop[column] = (reservedTop[column] ?? 0) + draft.height + CARD_GAP
    }

    const layout = layoutBoard(board, origin, {
      errors: projectBoardRef.current.errors,
      reservedTop
    })

    // Drafts are slotted above the cards of their own column, in the space just reserved.
    const placed = new Map<string, { x: number; y: number; width: number }>()
    for (const column of layout.columns) {
      let y = column.cardsTop - (reservedTop[column.optionId] ?? 0)
      for (const draft of drafts) {
        if (String(customDataOf(draft).sectionOptionId ?? '') !== column.optionId) continue
        placed.set(draft.id, { x: column.x, y, width: column.width })
        y += draft.height + CARD_GAP
      }
    }

    const nextOwn = own.map((element) => {
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

    const signature = JSON.stringify([layout.elements, [...placed.entries()]])
    if (signature === projectBoardRef.current.signature
        && scene.some((element) => isMirrorElement(element))) {
      // Nothing moved. Redrawing anyway would fight the reader's selection every poll.
      projectBoardRef.current = { ...projectBoardRef.current, board, columns: layout.columns }
      return
    }

    projectBoardRef.current = {
      board,
      columns: layout.columns,
      errors: projectBoardRef.current.errors,
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

    const created = instantiateIssueBlock(
      template,
      { x: column.x, y: column.cardsTop, width: column.width },
      column.optionId,
      `${Date.now()}`
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
    projectBoardRef.current = { board: null, columns: [], errors: {}, signature: '' }

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
      // The project mirror is derived from GitHub and rebuilt from it, so it is not this
      // board's to save. Left in, it would be stored, re-sent on every connection and
      // exported into the committed board file — a stale copy of something that already
      // has one authority.
      const currentElements = api.getSceneElementsIncludingDeleted()
        .filter((element) => !isMirrorElement(element))
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
              settleMirrorDrag(_elements, appState as unknown as Record<string, unknown>)
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
          />
        </div>
      </div>
    </div>
  )
}

export default App
