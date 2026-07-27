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
import { describeIgnoredClaims, resolveBoardSectionHotkeys } from '../../src/core/board-sections'
import type { BoardSectionElement } from '../../src/core/board-sections'
import { referenceImageName } from '../../src/core/pasted-images'
import { layoutLabel } from '../../src/core/text-layout'
import {
  layoutMirror,
  mirrorWidth,
  columnAt,
  mirrorAnchors,
  resolveMirrorOrigin,
  MIRROR_KIND,
  NOTES_OPTION_ID
} from '../../src/core/project-board-layout'
import type { CardImplementState, DraftBlock, MirrorColumn } from '../../src/core/project-board-layout'
import type { ProjectBoard } from '../../src/core/project-board-types'
import { TerminalPanel } from './components/TerminalPanel'
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_KIND,
  TERMINAL_SIZE,
  clampTerminalFont,
  terminalBlockData,
  terminalBlockElement,
  terminalGrid,
  terminalOrigin
} from '../../src/core/terminal-block'
import type { Bounds } from '../../src/core/terminal-block'
import { terminalLineBox } from './terminal-metrics'
import { WorkspaceTabs, WorkspaceSummary } from './components/WorkspaceTabs'
import { AddWorkspaceDialog, WorkspaceConfigDialog } from './components/WorkspaceDialogs'
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

/**
 * The key that jumps the viewport to the mirror.
 *
 * `Alt` because Excalidraw owns the bare letters — every tool has one — and much of
 * `Ctrl+Shift`. Matched on `code` rather than `key` so it survives a keyboard layout
 * where Alt produces a different character.
 */
const MIRROR_HOTKEY_CODE = 'KeyB';

/**
 * The key that brings the terminal back, whatever "back" means at the time.
 *
 * `Alt+T`, alongside `Alt+B` for the mirror: the same reasoning about who owns which keys,
 * and `T` for the thing it brings into view. It does more than the mirror's key, because
 * the terminal has three ways of being absent and this is the one answer to all of them —
 * scroll to the block, place one if the board has none, and open a session if none is
 * running. It used to stand down in exactly the two cases that needed it most: a shell that
 * had exited, and a board where the first attempt to open one failed.
 */
const TERMINAL_HOTKEY_CODE = 'KeyT';

/** How long to wait before telling the server the block was resized. */
const TERMINAL_RESIZE_DEBOUNCE_MS = 400;

/**
 * The mark on a terminal block that was placed before the mirror had been drawn.
 *
 * The block is anchored to the mirror's left edge, and a session opens well before the first
 * poll comes back: `POST /api/terminal` spawns a shell, `GET /api/project-board` spawns a
 * `gh`. So on a board that has a project, the block is placed against a mirror that is not
 * there yet, lands in the slot the mirror is about to take, and — being placed once and never
 * re-anchored — stays under it.
 *
 * This is what lets `renderMirror` move it out of the way exactly once. The mark comes off
 * with the move, so no later poll ever touches the block again and the reader's own dragging
 * is safe. A block already dragged is left alone even on that one pass: it is only rescued
 * while it is still standing where it was put.
 */
const TERMINAL_AWAITING_MIRROR = 'awaitingMirror';

/**
 * How long to wait before putting an erased block back.
 *
 * Not immediately: the erase arrives as a scene change, and re-placing the block inside the
 * handler for that change would put it under a pointer that is still erasing. Long enough
 * for the gesture to finish, short enough that the block reads as never having gone.
 */
const TERMINAL_RESTORE_DELAY_MS = 250;

/**
 * Where the reader's terminal font size is kept.
 *
 * In `localStorage` alongside the theme, and global rather than per board: it is a viewing
 * preference about the reader's eyes, not a fact about a project, and the same eyes read
 * every board. Deliberately **not** `customData` — the block is derived and stripped at
 * both doors, so a size stored there would be dropped on the way to the store and read as
 * the block forgetting it.
 */
const TERMINAL_FONT_STORAGE_KEY = 'excalidraw-terminal-font-size';

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
 * The rectangle a set of elements covers, or nothing when there are none.
 *
 * `getCommonBounds` answers an empty set with infinities, and arithmetic on those produces a
 * coordinate no viewport will ever reach. Nothing is the honest answer, and saying it in one
 * place is what keeps each caller from having to remember.
 */
const boundsOf = (elements: readonly { isDeleted?: boolean }[]): Bounds | null => {
  if (elements.length === 0) return null;
  const [minX, minY, maxX, maxY] = getCommonBounds(elements as readonly NonDeletedExcalidrawElement[]);
  return { minX, minY, maxX, maxY };
};

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

/** Whether the label editor that is open belongs to an issue block. */
const editingIssueBlock = (api: ExcalidrawImperativeAPI): boolean => {
  const editing = editingDraftId(api);
  if (!editing) return false;
  return api.getSceneElements().some(
    (element) => element.id === editing && customDataOf(element).kind === 'issue'
  );
};

/**
 * The timestamp a draft's id was built from, for blocks that carry no field.
 *
 * `draftCreatedAt` does reach the scene, and this is only a fallback. It was once believed
 * to be dropped somewhere between `instantiateIssueBlock` and the scene, and the ordering
 * was patched around that belief; the field was in fact never dropped. It survives
 * `convertToExcalidrawElements`, the round trip through `POST /api/elements`, and a reload —
 * `scripts/check-board-drafts-browser.mjs` reads it back out of the scene and asserts it.
 * What the run behind that belief was looking at was a scene whose blocks predated the
 * field: exactly `kind`, `projectBoardDraft` and `sectionOptionId` is what the `+` wrote
 * before the field existed, which is what a stale bundle would still have been writing.
 *
 * So this stays for the blocks that really do carry no field — the ones already sitting in
 * scenes saved before it was added. Reading a stamp back off an id is a weak key, an id
 * being the one field anything on the canvas is free to rewrite, which is why the field is
 * preferred and this is reached for only when there is nothing else.
 */
const createdAtFromId = (id: string): number | null => {
  const stamp = /^pbdraft-(\d+)/.exec(id)?.[1];
  if (!stamp) return null;
  const value = Number(stamp);
  return Number.isFinite(value) ? value : null;
};

/**
 * A draft block reduced to what the placement needs.
 *
 * `draftCreatedAt` is what orders the stack. A block dropped before that field was written
 * carries none; the stamp in its id stands in, and a block with neither is kept in the
 * order it arrives, so an old scene still lays out the same way twice running.
 */
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

/** Where the board a browser was last looking at is kept. */
const WORKSPACE_STORAGE_KEY = 'excalidraw-canvas-workspace'

/**
 * The board this load should open, decided before anything connects.
 *
 * Two answers were possible and both are here, in this order. `?workspace=` wins, so a
 * board has a URL: two can be open side by side in two tabs, and a link to one is a link
 * to that one rather than to whatever the reader last clicked. Failing that it is the
 * board this browser was last on, so a plain refresh returns where the reader was instead
 * of to the first tab in a registry they did not order.
 *
 * Both are validated against the registry the server just sent. A board that has been
 * removed from it, or a hand-typed id, must not strand the canvas on a store nothing
 * writes to — the first tab is the fallback, as it was before any of this.
 *
 * Null means "leave the default alone": with no registry the server keeps using its
 * default store, and naming a workspace it has never heard of would open an empty board.
 */
function resolveInitialWorkspace(list: WorkspaceSummary[]): string | null {
  if (list.length === 0 || !list[0]) return null
  const known = new Set(list.map((workspace) => workspace.id))

  const hints: (string | null)[] = []
  try {
    hints.push(new URLSearchParams(window.location.search).get('workspace'))
  } catch (error) {
    console.warn('Could not read the workspace from the URL:', error)
  }
  try {
    hints.push(window.localStorage?.getItem(WORKSPACE_STORAGE_KEY) ?? null)
  } catch (error) {
    console.warn('Could not read the last workspace:', error)
  }

  return hints.find((id): id is string => Boolean(id) && known.has(id as string)) ?? list[0].id
}

/**
 * Write the board down, in both places it can be read back from.
 *
 * The URL is rewritten rather than pushed: which board is open is where you *are*, not
 * somewhere you navigated to, and a history entry per tab click would make Back mean
 * something nobody asked for.
 */
function rememberWorkspace(workspaceId: string): void {
  try {
    window.localStorage?.setItem(WORKSPACE_STORAGE_KEY, workspaceId)
  } catch (error) {
    console.warn('Could not remember the workspace:', error)
  }
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.get('workspace') !== workspaceId) {
      url.searchParams.set('workspace', workspaceId)
      window.history.replaceState(null, '', url.toString())
    }
  } catch (error) {
    console.warn('Could not put the workspace in the URL:', error)
  }
}

/** What the pill is allowed to say. A socket that has never been up is not a failure. */
type ConnectionState = 'connecting' | 'connected' | 'disconnected'

/** First retry is immediate; from then on it doubles from here. */
const RECONNECT_BASE_MS = 250
const RECONNECT_CAP_MS = 5000
/**
 * Failed attempts tolerated as "connecting" before the pill admits the board is offline.
 * Four covers a server restart — 0, 250, 500 and 1000 ms of it — which is the common case
 * and is not worth alarming anyone about.
 */
const RECONNECT_PATIENCE = 4

/**
 * How often the page asks its socket whether it is still there.
 *
 * A browser cannot send a protocol ping, so the check is an application message the server
 * answers with `pong`. Without it a half-open socket — the laptop that slept, the tunnel
 * that died — keeps reading Connected until TCP gives up, which is minutes. The answer is
 * due before the next ping goes out; missing it closes the socket, which puts it on the
 * reconnect path instead of leaving a dead one on screen looking alive.
 */
const HEARTBEAT_INTERVAL_MS = 10000

/** Ceiling on holding autosync off during a board switch, if the new scene never lands. */
const BOARD_SWITCH_HOLD_MS = 8000

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  // Ref so WS message handlers (captured in stale closures) always see the latest API instance
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])
  // Starts *connecting*, not disconnected: on the first paint the socket has not failed,
  // it has not been opened yet, and telling the reader their board is offline while it is
  // still being resolved is the whole complaint this distinction answers.
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const isConnected = connectionState === 'connected'
  const websocketRef = useRef<WebSocket | null>(null)
  const reconnectAttemptsRef = useRef<number>(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const awaitingPongRef = useRef<boolean>(false)
  /** Bumped per socket, so the loader can run once per board per connection. */
  const connectionGenerationRef = useRef<number>(0)
  const loadedSceneKeyRef = useRef<string | null>(null)
  /** Set when the socket's own initial message already delivered this board's files. */
  const filesFromSocketRef = useRef<string | null>(null)

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
  /**
   * Whether a registry exists at all, which is not the same as it having projects in it.
   *
   * An empty registry is a board waiting for its first project and has to show the `+`
   * that adds one; no registry at all has nowhere to put it.
   */
  const [workspacesConfigured, setWorkspacesConfigured] = useState<boolean>(false)
  /** Which dialog is open, if any: the project picker or one project's settings. */
  const [workspaceDialog, setWorkspaceDialog] = useState<'add' | 'config' | null>(null)
  // WebSocket handlers close over their creation-time scope, so the ref is what the
  // async paths read — the state alone would send stale ids after a tab switch.
  const activeWorkspaceRef = useRef<string>('default')
  /**
   * Whether the board this load is for has been decided.
   *
   * Nothing that names a board may run before this: the socket used to be opened on
   * `default` and then switched, which cost a second connection and a blank canvas on
   * every single load. The state is what the per-board effects wait on; the ref is what
   * the connect path reads, because it is called from handlers that never re-render.
   */
  const [boardReady, setBoardReady] = useState<boolean>(false)
  const boardReadyRef = useRef<boolean>(false)
  /** The board whose first scene is still on its way, while the previous one is on screen. */
  const pendingSceneWorkspaceRef = useRef<string | null>(null)

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
   *
   * `resume` continues an attempt whose server did not survive it, in the checkout that
   * attempt left behind. The server refuses it unless it agrees there is one to continue, so
   * a resume can never quietly become a fresh run over work nobody read.
   */
  const implementIssueFromBlock = async (
    target: IssueTarget,
    resume = false
  ): Promise<string | null> => {
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
        body: JSON.stringify({ url: target.issueUrl, ...(resume ? { resume: true } : {}) })
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
          ? {
              ...current,
              implementState: null,
              implementUrl: null,
              implementError: null,
              implementStartedAt: null,
              implementEndedAt: null
            }
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
  /**
   * A sync that was asked for while the counter was up, and still owes the server a write.
   *
   * `scheduleAutoSync` used to answer a refusal by returning, which armed nothing and left
   * nothing to re-arm it: the change waited for some *later* change that happened not to be
   * suppressed. That is #92 — a block dropped with `+` sat in the browser alone until the
   * next thing the reader did carried it, and a research run clicked in between answered
   * `Element … not found`. The refusal is remembered here instead, and honoured the moment
   * the counter drops back to zero.
   */
  const autoSyncPendingRef = useRef<boolean>(false)
  const userInteractedRef = useRef<boolean>(false)

  /** The last set of rejected hotkey claims that was printed, so it is printed once. */
  const sectionClaimsRef = useRef<string>('')

  /**
   * Say once when a section asked for a key it cannot have.
   *
   * A reserved or duplicated claim is ignored rather than honoured, and an ignored claim
   * with nothing said is a key that silently does nothing — the drawing looks right and
   * the board looks broken. Printed from `onChange`, which is also where the board is
   * edited, and guarded by the last thing printed because `onChange` fires on every
   * pointer move.
   */
  const reportSectionClaims = (elements: readonly unknown[]): void => {
    const { ignored } = resolveBoardSectionHotkeys(elements as unknown as BoardSectionElement[])
    const signature = describeIgnoredClaims(ignored)
    if (signature === sectionClaimsRef.current) return
    sectionClaimsRef.current = signature
    if (signature) console.warn(`Board section hotkey ignored: ${signature}`)
  }

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

  /**
   * Drop the counter, and let through a sync that was refused while it was up.
   *
   * Every release goes through here, because a refusal remembered by `scheduleAutoSync` is
   * only worth remembering if something acts on it, and this is the one moment the answer
   * can change. Still suppressed after the decrement — updates nest — means the next
   * release is the one that will do it.
   */
  const releaseAutoSyncSuppression = (): void => {
    suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
    if (suppressAutoSyncCountRef.current > 0) return
    if (!autoSyncPendingRef.current) return
    scheduleAutoSync()
  }

  const applySceneUpdateWithoutAutoSync = (
    api: ExcalidrawImperativeAPI,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): void => {
    suppressAutoSyncCountRef.current += 1
    api.updateScene(scene)
    setTimeout(() => {
      releaseAutoSyncSuppression()
    }, 0)
  }

  /**
   * Hold autosync off for the length of a board switch.
   *
   * The scene now stays on screen until the new board's elements land, which means there
   * is a window where the canvas shows one board while `activeWorkspaceRef` already names
   * another. An autosync in that window would write the board you left into the store of
   * the board you went to. The timer is a floor, not the mechanism: the hold is released
   * when the new scene arrives, and only expires if it never does.
   */
  const autoSyncHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const holdAutoSyncForSwitch = (): void => {
    if (autoSyncHoldRef.current) return
    suppressAutoSyncCountRef.current += 1
    autoSyncHoldRef.current = setTimeout(() => { finishBoardSwitch() }, BOARD_SWITCH_HOLD_MS)
  }

  /** The new board is on screen (or never will be): let autosync go again. */
  const finishBoardSwitch = (): void => {
    pendingSceneWorkspaceRef.current = null
    if (!autoSyncHoldRef.current) return
    clearTimeout(autoSyncHoldRef.current)
    autoSyncHoldRef.current = null
    // The new board's scene is already on screen by the time this runs, so a sync refused
    // during the switch is now a sync of that board into its own store — which is what the
    // hold was protecting, not something it was meant to lose.
    releaseAutoSyncSuppression()
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

  /**
   * Where this board's mirror was put, once something measured it.
   *
   * The region used to be re-measured on every poll, which is what let it drift away from
   * the board's own content with nobody touching either (#99). It is decided once now and
   * kept — the terminal's model, and for the terminal's reason: a redraw that re-anchored a
   * region every twenty seconds is a redraw that moves it. Reset on a board switch, because
   * the next board's content is not this one's.
   */
  const mirrorOriginRef = useRef<{ x: number; y: number } | null>(null)

  const clearMirror = (): void => {
    projectBoardRef.current = { board: null, columns: [], errors: {}, implementing: {}, signature: '' }
    draftGeometryRef.current = ''
    mirrorOriginRef.current = null
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
   * Anchored to the left of whatever else is on the canvas — measured **once**, and then
   * kept. Recomputing it on every poll is what let the region drift away from the board's
   * own content with nobody touching either (#99); `resolveMirrorOrigin` has the whole of
   * that reasoning, and `mirrorAnchors` says which elements the measurement is allowed to
   * see. Both live beside the layout arithmetic so a check can ask them without a browser.
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
    // placed *from* this region's own left edge, so measuring against it would walk the
    // mirror left onto the block, and the block left again, on every pass. Since #96 the
    // two sit side by side on the same side of the content, which makes this load bearing
    // rather than merely tidy. A title bound to the block goes with the block — that is
    // the rule the other two doors already state, and `mirrorAnchors` is where all of it
    // is now said once, so a check can ask it without a browser.
    const anchors = mirrorAnchors(own)

    // The notes column is drawn too, and it is as wide as the rest, so the width the first
    // measurement places the region by has to include it — `mirrorWidth`, not `boardWidth`,
    // which counts only the options the project declares.
    const width = mirrorWidth(board)
    const bounds = anchors.length > 0
      ? (() => {
        const [minX, minY] = getCommonBounds(anchors as readonly NonDeletedExcalidrawElement[])
        return { minX, minY }
      })()
      : null
    const { origin, settled } = resolveMirrorOrigin(mirrorOriginRef.current, bounds, width)
    // Only a measured origin is remembered. A poll that ran before the scene arrived would
    // otherwise pin the region where an empty canvas put it for the rest of the session.
    if (settled) mirrorOriginRef.current = origin

    // The blocks the `+` dropped hold the top of their column, newest first, and the
    // mirrored cards start below them. Both halves of that arithmetic come from
    // `layoutMirror`, so the room reserved and the slot a block is put in cannot disagree
    // — and it is what draws the notes column those blocks live in, which the project
    // itself declares nothing for.
    const layout = layoutMirror(board, origin, {
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

    // A terminal block placed before this board landed is standing in the slot the mirror is
    // about to take — the no-mirror fallback, chosen when there was no mirror to see. Move it
    // out of the way, once, and take the mark off with it: a block is placed once and never
    // re-anchored, and this pass is the one exception, not a second cadence.
    //
    // Only while it is still exactly where it was put. A reader who dragged it in the seconds
    // before the first poll has said where it goes, and that outranks the arithmetic — as has
    // a block detached beside another, or restored at a geometry it remembers, neither of
    // which is ever at this origin.
    const marked = own.filter((element) => isTerminalElement(element)
      && customDataOf(element)[TERMINAL_AWAITING_MIRROR] === true)
    const placedAt = marked.length > 0
      ? terminalOrigin(boundsOf(own.filter((element) => !isTerminalElement(element))), null)
      : null
    const rescue = placedAt
      ? terminalOrigin(null, { minX: origin.x, minY: origin.y,
                               maxX: origin.x + layout.bounds.width,
                               maxY: origin.y + layout.bounds.height })
      : null
    const strandedIds = new Set(marked.map((element) => element.id))

    const nextOwn = own.map((element) => {
      if (isTerminalElement(element)) {
        // The mark comes off whether or not the block moved, so this can never fire twice.
        if (!strandedIds.has(element.id)) return element
        const { [TERMINAL_AWAITING_MIRROR]: _placedBlind, ...rest } = customDataOf(element)
        const moved = rescue && placedAt
          && element.x === placedAt.x && element.y === placedAt.y
          ? rescue
          : {}
        // Excalidraw reconciles by version, so a shape whose only change is its `customData`
        // and whose version stands still is one it may keep as it was.
        return { ...element, ...moved, version: (element.version ?? 1) + 1, customData: rest }
      }
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
    // in its slot, be skipped as "nothing moved". A pending rescue is in it for the same
    // reason — the mirror itself may be identical to the last pass, and the terminal still
    // has to be moved out from under it.
    const signature = JSON.stringify([layout.elements, layout.drafts, frozen, [...strandedIds], rescue])
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
      // The notes column is the canvas's own and has no option to write, so a card dropped
      // into it is put back and nothing is sent. Sending it would reach the server, be
      // refused there for naming a column the project does not have, and write that refusal
      // onto the card — an error message for a drop this side already knows is impossible.
      // A silent snap-back is what a card that cannot be moved already does.
      if (column && column.optionId !== NOTES_OPTION_ID
          && custom.draggable === true && typeof custom.itemId === 'string') {
        void moveMirrorCard(custom.itemId, column.optionId)
        return
      }
    }

    // Dropped in a gap, onto the notes column, or onto one it cannot be moved to. Put it back.
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
   * The notes column, which is the only column this can honestly create into: a block is
   * an observation until a run turns it into an issue, and that column is the one the
   * canvas draws for itself rather than mirroring from an option. The id it stamps onto
   * the block is therefore the reserved one, which no project can rename away.
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
  // Blocks on the right of the board, mirroring the mirror: the project's own columns on
  // one side, the shells running in the project on the other. The shapes are derived, like
  // the mirror's cards — they are rebuilt whenever a session is there to draw, and they are
  // stripped before the autosync and before the export, because a saved terminal is a dead
  // frame around a session that has ended.
  //
  // One block held one session until #94. Now a block holds a *strip* of them and names
  // which in `customData.sessions`, and a tab detached from one block becomes a block of its
  // own — which makes splitting a drag and joining a button, both of them geometry
  // Excalidraw already owns. What is not saved with the arrangement is the arrangement: the
  // shapes are derived, so a reload puts every live session back into one block. The sessions
  // are the server's and survive; the tab layout is this page's and does not.

  interface TerminalStatus {
    cwd: string
    shell: string
    /** `pty` or `pipe` — which of the two the server got, so the block can say so. */
    mode: string
    cols: number
    rows: number
  }

  interface TerminalSessionState {
    status: TerminalStatus | null
    output: string
    /** Why the tab is inert, once it is: the shell exited, or the server refused. */
    ended: string | null
  }

  /**
   * Every session this board knows about, by id.
   *
   * The ref is the authority and the state is the copy that renders. The WebSocket handlers
   * are attached at mount and close over a scope where the state is still its initial value,
   * and the scene-replacing paths run from inside them — same reason `activeWorkspaceRef`
   * exists. Writing both in one place is what keeps a chunk of output from being applied to
   * the set of sessions as it was several messages ago.
   */
  const terminalSessionsRef = useRef<Record<string, TerminalSessionState>>({})
  const [terminalSessions, setTerminalSessions] = useState<Record<string, TerminalSessionState>>({})
  /** The server's cap, so the strip's `+` can refuse rather than ask and be told 409. */
  const terminalLimitRef = useRef<number>(0)
  const [terminalLimit, setTerminalLimit] = useState<number>(0)
  /** The board this page has already opened its first shell for. */
  const terminalAutoOpenedRef = useRef<string | null>(null)

  const writeTerminalSessions = (
    mutate: (current: Record<string, TerminalSessionState>) => Record<string, TerminalSessionState>
  ): void => {
    const next = mutate(terminalSessionsRef.current)
    terminalSessionsRef.current = next
    setTerminalSessions(next)
  }

  const terminalStatusOf = (session: Record<string, any> | null | undefined): TerminalStatus | null =>
    session
      ? {
        cwd: session.cwd,
        shell: session.shell,
        mode: session.mode ?? 'pipe',
        cols: session.cols,
        rows: session.rows
      }
      : null

  /** One block on screen: where it is, and which of its tabs is on top. */
  interface TerminalView {
    elementId: string
    rect: Rect
    zoom: number
    suppressed: boolean
    sessions: string[]
    active: string
  }

  const [terminalViews, setTerminalViews] = useState<TerminalView[]>([])
  /** What was last rendered, so a pan that changes nothing does not re-render every block. */
  const terminalViewsRef = useRef<string>('')

  /** The grid last reported per session, so a pan or a re-render does not re-report a size. */
  const terminalGridRef = useRef<Map<string, string>>(new Map())
  const terminalResizeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  /**
   * Every block's scene geometry and what it is holding, from the last time it was drawn.
   *
   * Two things read it. A font change is a resize the reader did not drag — the block kept
   * its size and the screen inside it did not — so the grid has to be re-derived from a
   * shape nothing is about to report about. And a block that is *gone* has to be put back
   * where it was (#93/#98), which needs the geometry after the shape has stopped existing.
   */
  const terminalGeometryRef = useRef<Map<string, {
    x: number; y: number; width: number; height: number; sessions: string[]
  }>>(new Map())

  /**
   * Where each session's block last was, kept per session rather than per block.
   *
   * A block erased takes its id with it, and what has to be restored is *those tabs, there*.
   * Keyed by session, the restore groups the orphans by the geometry they remember and puts
   * a block back around each group — which for the ordinary case of one erased block is one
   * block, at its own size and position.
   */
  const terminalHomesRef = useRef<Map<string, { x: number; y: number; width: number; height: number }>>(new Map())

  /** A restore already scheduled, so a burst of scene changes queues one and not thirty. */
  const terminalRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * How big the terminal's text is, before the board's zoom multiplies it.
   *
   * The reader's, set by the `+` and `-` on the block's header and remembered across
   * reloads the way the theme is. It is an input to the grid rather than a display tweak:
   * bigger text in the same block is fewer columns and fewer rows, because xterm sizes its
   * canvas from `cols` × `rows` × the font and anything past the frame is clipped rather
   * than scrolled. See `terminalGrid` in `src/core/terminal-block.ts`.
   */
  const [terminalFont, setTerminalFont] = useState<number>(() => {
    if (typeof window === 'undefined') return TERMINAL_FONT_SIZE
    try {
      return clampTerminalFont(window.localStorage?.getItem(TERMINAL_FONT_STORAGE_KEY))
    } catch (error) {
      console.warn('Failed to read the terminal font size from localStorage:', error)
      return TERMINAL_FONT_SIZE
    }
  })
  /** The same value for the report path, which runs from timers and closes over its scope. */
  const terminalFontRef = useRef<number>(terminalFont)

  /**
   * Write an arrangement of the blocks into the scene, if it is a different one.
   *
   * Every operation on the strip — switching, adding, closing, detaching, merging, and the
   * reconciliation that follows a scene being replaced — comes through here, because they
   * are all the same edit: which sessions each block holds, and which of them is on top. A
   * block left holding none is removed rather than left as an empty frame.
   *
   * The comparison at the end is not an optimisation. `onChange` runs the sync that reads
   * these blocks, and an update that wrote the same arrangement back would be a loop.
   */
  const commitTerminalLayout = (
    layout: Map<string, { sessions: string[]; active: string }>,
    added: Record<string, unknown>[] = []
  ): void => {
    const api = excalidrawAPIRef.current
    if (!api) return

    const scene = api.getSceneElementsIncludingDeleted()

    // One session, one tab, and the first block that claims it keeps it. Two paths add a
    // tab for a session that has just opened — the response to the request that opened it,
    // and the announcement the socket makes to every viewer of the board, this one
    // included — so a layout that took both at face value would list it twice. Drawn twice
    // it would be two emulators writing one transcript, with a keystroke going to whichever
    // had the keyboard.
    const seen = new Set<string>()
    for (const element of scene) {
      if (element.isDeleted || !isTerminalElement(element)) continue
      const entry = layout.get(element.id)
      if (!entry) continue
      const unique: string[] = []
      for (const sessionId of entry.sessions) {
        if (seen.has(sessionId)) continue
        seen.add(sessionId)
        unique.push(sessionId)
      }
      entry.sessions = unique
      if (!entry.sessions.includes(entry.active)) entry.active = entry.sessions[0] ?? ''
    }

    const dropped = new Set<string>()
    for (const element of scene) {
      if (element.isDeleted || !isTerminalElement(element)) continue
      if ((layout.get(element.id)?.sessions.length ?? 0) === 0) dropped.add(element.id)
    }
    // A label Excalidraw bound to a block goes when the block does. Left behind it is a text
    // element whose container nothing has heard of — and worse, the sync's test for "derived"
    // reads the container off the scene, so an orphan label would stop looking derived and
    // start being stored.
    for (const element of scene) {
      if (element.containerId && dropped.has(element.containerId)) dropped.add(element.id)
    }

    let changed = added.length > 0 || dropped.size > 0
    const next = scene
      .filter((element) => !dropped.has(element.id) && !element.isDeleted)
      .map((element) => {
        if (!isTerminalElement(element)) return element
        const entry = layout.get(element.id)
        if (!entry) return element
        const current = terminalBlockData(element.customData)
        if (current.sessions.join(',') === entry.sessions.join(',')
          && current.active === entry.active) {
          return element
        }
        changed = true
        return {
          ...element,
          // Excalidraw reconciles by version, so a shape whose only change is its
          // `customData` and whose version stands still is a shape it may keep as it was.
          version: (element.version ?? 1) + 1,
          customData: {
            ...customDataOf(element),
            kind: TERMINAL_KIND,
            sessions: entry.sessions,
            active: entry.active
          }
        }
      })

    if (!changed) return
    // The tombstones go back in **around** the conversion rather than through it.
    // `convertToExcalidrawElements` rebuilds each element from a skeleton and has no
    // `isDeleted` to rebuild from, so anything deleted that is handed to it comes back
    // alive — which is how a block restored one tick after an eraser drag used to resurrect
    // everything else the drag had taken (#98). Dropping them instead is not the answer
    // either: the sync sends deleted elements on purpose, because the store never treats
    // absence as a deletion, so a tombstone lost here is a shape that stays alive on the
    // server. So they are set aside, and appended untouched.
    const tombstones = scene.filter((element) => element.isDeleted && !dropped.has(element.id))
    applySceneUpdateWithoutAutoSync(api, {
      elements: [
        ...convertElementsPreservingImageProps(
          [...next, ...added] as unknown as Partial<ExcalidrawElement>[]
        ),
        ...tombstones
      ] as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER
    })
  }

  /** What each block holds right now, read off the scene. */
  const terminalLayoutOf = (
    blocks: readonly ExcalidrawElement[]
  ): Map<string, { sessions: string[]; active: string }> =>
    new Map(blocks.map((block) => {
      const data = terminalBlockData(block.customData)
      return [block.id, { sessions: [...data.sessions], active: data.active }]
    }))

  const terminalBlocksOf = (api: ExcalidrawImperativeAPI): ExcalidrawElement[] =>
    api.getSceneElementsIncludingDeleted()
      .filter((element) => !element.isDeleted && isTerminalElement(element)) as ExcalidrawElement[]

  /**
   * A block for sessions that have nowhere to be.
   *
   * Three placements, and they answer different questions. `beside` is a detach — the new
   * block goes next to the one the tab came out of. `at` is a **restore**: the block was
   * erased and putting it back means putting it *back*, at the size and position the reader
   * had it, because a restore that re-anchored it past the mirror would answer an accidental
   * erase by also undoing a drag. Neither is where a terminal *goes*, which is the last case:
   * one gap left of the mirror, or of the content on a board that has no mirror.
   */
  const newTerminalBlock = (
    api: ExcalidrawImperativeAPI,
    sessions: string[],
    where: {
      beside?: { x: number; y: number; width: number; height: number }
      at?: { x: number; y: number; width: number; height: number }
    } = {}
  ): Record<string, unknown> => {
    const scene = api.getSceneElementsIncludingDeleted().filter((element) => !element.isDeleted)

    // The mirror is what the block clears when the board has one, and its left edge is read
    // from the shapes themselves rather than recomputed: `renderMirror` is the authority on
    // where the region went, and two derivations of one number is how they come to disagree.
    const mirror = boundsOf(scene.filter(isMirrorElement))

    // No mirror drawn *yet* is not the same as a board that has none, and from here the two
    // are indistinguishable: the poll that draws it spawns a `gh` and takes seconds, while a
    // session opens on a `POST` that spawns a shell. So a block placed while there is none to
    // see is marked, and `renderMirror` moves it out of the mirror's slot on the first board
    // that lands — once, and only if it is still standing at the origin below.
    const blind = mirror ? {} : { [TERMINAL_AWAITING_MIRROR]: true }

    const beside = where.beside
    if (beside) {
      return terminalBlockElement(
        // Beside the block it came out of, not on top of it. Where it goes from there is the
        // reader's business — it is an ordinary shape and the canvas moves it.
        { x: beside.x + beside.width + 40, y: beside.y },
        { width: beside.width, height: beside.height },
        { sessions, active: sessions[0] ?? '' }
      )
    }
    if (where.at) {
      return terminalBlockElement(
        { x: where.at.x, y: where.at.y },
        { width: where.at.width, height: where.at.height },
        // Marked, because the geometry being restored may itself have been chosen blind — a
        // block erased in the seconds before the first poll is put back in the mirror's slot.
        // It costs nothing when it was not: the move is refused for any block that is not at
        // that origin, and the mark comes off either way.
        { sessions, active: sessions[0] ?? '', ...blind }
      )
    }

    // What this board authored, which is neither the mirror nor a terminal block. Only used
    // when there is no mirror to measure against.
    const bounds = boundsOf(scene.filter((element) => !isDerivedElement(element)))

    return terminalBlockElement(terminalOrigin(bounds, mirror), TERMINAL_SIZE, {
      sessions,
      active: sessions[0] ?? '',
      ...blind
    })
  }

  /**
   * Make the blocks agree with the sessions the server has.
   *
   * The two drift for ordinary reasons and in both directions: a shell exits and its tab has
   * to go, a scene is replaced wholesale and every block with it, a session opened in another
   * window arrives over the socket with no block to be in, an eraser is dragged across a
   * block and takes it. So this is written as "what should the strip be", not as a patch —
   * it drops tabs for sessions that have gone, drops a block left with none, and gives every
   * session with nowhere to be a home.
   *
   * It is also where #93's answer lives, generalised. Excalidraw's eraser respects exactly
   * one thing — `locked` — and locking a terminal block would take away the selection, the
   * drag and the corner resize that *are* the interface here. So the block stays erasable
   * and the erase is undone: an orphan whose shell is still alive is put back in a block at
   * the geometry it remembers. Nothing in the erase path kills a shell, so a block that
   * stayed gone would leave a live process with no way to Ctrl+C it — the keyboard reaches
   * the shell only through the overlay.
   *
   * A tab whose shell has already **exited** is not restored, and is forgotten instead. Once
   * the shell has gone the tab is a notice, and a notice the reader clears stays cleared.
   */
  const reconcileTerminalBlocks = (options: { scroll?: boolean } = {}): void => {
    const api = excalidrawAPIRef.current
    if (!api) return

    const known = terminalSessionsRef.current
    const live = Object.keys(known)
    const blocks = terminalBlocksOf(api)
    const layout = terminalLayoutOf(blocks)

    // A session belongs to exactly one block. Two claiming it would draw one shell twice and
    // put its keystrokes wherever the second copy happened to be focused.
    const claimed = new Set<string>()
    for (const block of blocks) {
      const entry = layout.get(block.id)
      if (!entry) continue
      entry.sessions = entry.sessions.filter((id) => live.includes(id) && !claimed.has(id))
      entry.sessions.forEach((id) => claimed.add(id))
      if (!entry.sessions.includes(entry.active)) entry.active = entry.sessions[0] ?? ''
    }

    const orphans = live.filter((id) => !claimed.has(id))
    const cleared = orphans.filter((id) => known[id]?.ended)
    const homeless = orphans.filter((id) => !known[id]?.ended)
    const added: Record<string, unknown>[] = []

    // Grouped by the geometry they remember, so an erased block with two tabs comes back as
    // one block with two tabs rather than as two blocks in the same place.
    const restoring = new Map<string, string[]>()
    const stray: string[] = []
    for (const sessionId of homeless) {
      const home = terminalHomesRef.current.get(sessionId)
      if (!home) { stray.push(sessionId); continue }
      const key = `${home.x},${home.y},${home.width},${home.height}`
      restoring.set(key, [...(restoring.get(key) ?? []), sessionId])
    }
    for (const [key, sessions] of restoring) {
      const [x, y, width, height] = key.split(',').map(Number)
      added.push(newTerminalBlock(api, sessions, { at: { x, y, width, height } }))
    }

    // Never on the board before — opened in another window, or the first of them all. It
    // goes into a block that is already there, or into one placed where a terminal goes.
    if (stray.length > 0) {
      const host = blocks.find((block) => (layout.get(block.id)?.sessions.length ?? 0) > 0)
      if (host) {
        const entry = layout.get(host.id)!
        entry.sessions = [...entry.sessions, ...stray]
        if (!entry.active) entry.active = entry.sessions[0]
      } else if (added.length > 0) {
        // A block is already being placed this pass; the strays join it rather than getting
        // a second one beside it.
        const first = added[0] as { customData: { sessions: string[]; active: string } }
        first.customData.sessions = [...first.customData.sessions, ...stray]
      } else {
        added.push(newTerminalBlock(api, stray))
      }
    }

    if (cleared.length > 0) {
      writeTerminalSessions((current) => {
        const next = { ...current }
        for (const sessionId of cleared) delete next[sessionId]
        return next
      })
      for (const sessionId of cleared) {
        terminalHomesRef.current.delete(sessionId)
        terminalGridRef.current.delete(sessionId)
      }
    }

    commitTerminalLayout(layout, added)

    if (options.scroll) {
      const placed = terminalBlocksOf(api)
      if (placed.length > 0) {
        api.scrollToContent(placed as unknown as ExcalidrawElement[], { fitToViewport: true, animate: true })
      }
    }
  }

  /**
   * Reconcile shortly, once, after the board has been seen to lose a block.
   *
   * On a timer rather than at once, because this is noticed from inside the scene-change
   * handler and the pointer that erased it may still be down. One timer for a burst of
   * changes, so an eraser dragged across the canvas queues one restore and not thirty.
   */
  const scheduleTerminalRestore = (): void => {
    if (terminalRestoreTimerRef.current) return
    terminalRestoreTimerRef.current = setTimeout(() => {
      terminalRestoreTimerRef.current = null
      reconcileTerminalBlocks()
    }, TERMINAL_RESTORE_DELAY_MS)
  }

  /**
   * Adopt whatever the board already has, and open one if it has none.
   *
   * A reload, a second window or a tab switched away and back all arrive at a server that
   * still owns the shells, and the right answer is to draw them rather than to start more.
   * A 404 or a 403 is one of the guards — the feature is off, or the server is reachable
   * from the network — and both mean no block at all.
   */
  const adoptTerminalSessions = async (workspace: string): Promise<void> => {
    try {
      const response = await fetch(apiUrl('/api/terminal'))
      if (!response.ok) return
      const body = await response.json().catch(() => ({}))

      terminalLimitRef.current = Number(body?.limit) || 0
      setTerminalLimit(terminalLimitRef.current)

      const listed: Record<string, any>[] = Array.isArray(body?.sessions) ? body.sessions : []
      if (listed.length === 0) {
        // Once per board per page, and marked before the request rather than after it. The
        // effect below runs again whenever the board settles, and two runs that both read
        // "no sessions" before either had opened one would open two — which the 409 used to
        // make impossible and the cap no longer does.
        if (terminalAutoOpenedRef.current === workspace) return
        terminalAutoOpenedRef.current = workspace
        await openTerminalSession()
        return
      }

      writeTerminalSessions(() => Object.fromEntries(listed.map((session) => [session.id, {
        status: terminalStatusOf(session),
        output: typeof session.scrollback === 'string' ? session.scrollback : '',
        ended: session.exitCode === null || session.exitCode === undefined
          ? null
          : `the shell exited with code ${session.exitCode}`
      }])))
      reconcileTerminalBlocks()
    } catch (error) {
      console.warn('Could not read the terminal sessions:', error)
    }
  }

  /**
   * Open one more shell, and put its tab where it was asked for.
   *
   * The 409 is the cap now rather than "there is already one", and it is still not a failure
   * worth throwing away: the strip's `+` refuses on its own once the cap is reached, so this
   * only sees one when another window got there first.
   */
  const openTerminalSession = async (blockId?: string): Promise<void> => {
    try {
      const response = await fetch(apiUrl('/api/terminal'), { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 409) console.warn(body?.error)
        return
      }

      const session = body?.session
      if (!session?.id) return
      writeTerminalSessions((current) => ({
        ...current,
        [session.id]: { status: terminalStatusOf(session), output: '', ended: null }
      }))

      // The block that asked, or any block already holding tabs. Either way the new session
      // becomes the tab on top: opening a shell is a request to look at it, and a board
      // whose last shell had exited would otherwise answer Alt+T by leaving the dead tab
      // drawn and the new one behind it.
      const api = excalidrawAPIRef.current
      const blocks = api ? terminalBlocksOf(api) : []
      const host = blockId
        ? blocks.find((block) => block.id === blockId)
        : blocks.find((block) => terminalBlockData(block.customData).sessions.length > 0)
      if (api && host) {
        const layout = terminalLayoutOf(terminalBlocksOf(api))
        // Taken off every block before it is put on this one. The socket's announcement of
        // this same session may already have arrived and given it a home; what was asked for
        // is a tab in *this* block, and moving it there is what that means.
        for (const entry of layout.values()) {
          entry.sessions = entry.sessions.filter((id) => id !== session.id)
        }
        const entry = layout.get(host.id)!
        entry.sessions = [...entry.sessions, session.id]
        entry.active = session.id
        commitTerminalLayout(layout)
      } else {
        reconcileTerminalBlocks()
      }
    } catch (error) {
      console.warn('Could not open a terminal:', error)
    }
  }

  /** End a shell and take its tab with it. The block goes too if that was its last one. */
  const closeTerminalSession = async (sessionId: string): Promise<void> => {
    try {
      await fetch(apiUrl(`/api/terminal?sessionId=${encodeURIComponent(sessionId)}`), { method: 'DELETE' })
    } catch (error) {
      console.warn('Could not close the terminal session:', error)
    }
    // Locally regardless of what the request said: a session the server no longer has is one
    // this board must stop drawing, and the `terminal_exit` that confirms it may never come
    // if the request is what failed.
    writeTerminalSessions((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    terminalGridRef.current.delete(sessionId)
    reconcileTerminalBlocks()
  }

  /** Which tab is on top of a block. */
  const selectTerminalTab = (blockId: string, sessionId: string): void => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const layout = terminalLayoutOf(terminalBlocksOf(api))
    const entry = layout.get(blockId)
    if (!entry || !entry.sessions.includes(sessionId)) return
    entry.active = sessionId
    commitTerminalLayout(layout)
  }

  /**
   * Take a tab out of its block and give it a block of its own.
   *
   * This is the whole of "split", and it is deliberately the cheap reading of it: the second
   * block is an ordinary shape, so moving it, resizing it and putting it beside the first
   * are all things the canvas already does. A splitter *inside* one block would have been a
   * drag handle competing with the shape's own — which is the collision this overlay has
   * been avoiding since it was written.
   */
  const detachTerminalSession = (blockId: string, sessionId: string): void => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const blocks = terminalBlocksOf(api)
    const source = blocks.find((block) => block.id === blockId)
    const layout = terminalLayoutOf(blocks)
    const entry = source ? layout.get(source.id) : null
    if (!source || !entry || !entry.sessions.includes(sessionId)) return
    // A block with one tab is already its own block; detaching it would drop the block it is
    // in and add an identical one beside it.
    if (entry.sessions.length < 2) return

    entry.sessions = entry.sessions.filter((id) => id !== sessionId)
    if (entry.active === sessionId) entry.active = entry.sessions[0] ?? ''
    commitTerminalLayout(layout, [newTerminalBlock(api, [sessionId], { beside: source })])
  }

  /**
   * Put a block's tabs into the nearest other terminal block, and drop the block.
   *
   * "Nearest" rather than a chosen target, because the choosing is the drag: the reader puts
   * the block beside the one they mean and presses this. Dragging the *tab* onto another
   * block's strip was the other reading, and it would have meant the strip taking drag
   * events across the whole width of the block — more pointer than this overlay may take
   * without costing the shape its handles.
   */
  const mergeTerminalBlock = (blockId: string): void => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const blocks = terminalBlocksOf(api)
    const source = blocks.find((block) => block.id === blockId)
    if (!source) return

    const centre = (block: ExcalidrawElement): { x: number; y: number } =>
      ({ x: block.x + block.width / 2, y: block.y + block.height / 2 })
    const from = centre(source)
    const target = blocks
      .filter((block) => block.id !== blockId)
      .map((block) => ({ block, distance: Math.hypot(centre(block).x - from.x, centre(block).y - from.y) }))
      .sort((a, b) => a.distance - b.distance)[0]?.block
    if (!target) return

    const layout = terminalLayoutOf(blocks)
    const moving = layout.get(source.id)?.sessions ?? []
    const into = layout.get(target.id)!
    into.sessions = [...into.sessions, ...moving]
    if (!into.active) into.active = into.sessions[0] ?? ''
    layout.set(source.id, { sessions: [], active: '' })
    commitTerminalLayout(layout)
  }

  /** Keystrokes waiting to be sent, per session, and which queues are already sending. */
  const terminalInputRef = useRef<Map<string, string>>(new Map())
  const terminalSendingRef = useRef<Set<string>>(new Set())

  /**
   * Send what is queued for one session, in order, and do not lose a keystroke.
   *
   * Both halves of that matter now and neither did before. A line at a time, one request
   * carried the whole command and a failure was visible — nothing ran. A keystroke at a
   * time, `pwd` is three requests: fired off in parallel they can arrive as `pdw`, and one
   * that fails silently makes it `pd`. So they are queued and sent one after another, and
   * whatever accumulated while a request was in flight goes out as a single write — which
   * is what a fast typist or a paste looks like anyway.
   *
   * A queue per session rather than one for the board: two tabs being typed into share
   * nothing but the network, and a single queue would make one tab's slow request hold the
   * other's keystrokes — while a single *in-flight* flag would let them interleave into the
   * wrong shell.
   */
  const flushTerminalInput = async (sessionId: string): Promise<void> => {
    if (terminalSendingRef.current.has(sessionId)) return
    terminalSendingRef.current.add(sessionId)
    try {
      while (terminalInputRef.current.get(sessionId)) {
        const data = terminalInputRef.current.get(sessionId) ?? ''
        terminalInputRef.current.delete(sessionId)
        let sent = false
        for (let attempt = 0; attempt < 3 && !sent; attempt++) {
          try {
            sent = (await fetch(apiUrl('/api/terminal/input'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, data })
            })).ok
          } catch {
            sent = false
          }
          if (!sent) await new Promise((resolve) => setTimeout(resolve, 120))
        }
        if (!sent) console.warn('Could not send to the terminal; those keystrokes were dropped')
      }
    } finally {
      terminalSendingRef.current.delete(sessionId)
    }
  }

  /**
   * Queue keystrokes for one shell, exactly as they were pressed.
   *
   * Bytes rather than a line, and nothing appended: what the emulator hands over is already
   * what a terminal sends — `\r` for Enter, `\x03` for Ctrl+C, `ESC [ A` for an arrow — and
   * a newline added to any of those would turn a keystroke into something else. The echo
   * comes back over the socket, from the shell, like any other output.
   *
   * The session is named on every write. It is the whole of what a strip of tabs needs from
   * this route: without it the server would resolve "whichever one is open", and a board
   * with two tabs would type into whichever the map happened to yield first.
   */
  const sendTerminalInput = (sessionId: string, data: string): void => {
    terminalInputRef.current.set(sessionId, (terminalInputRef.current.get(sessionId) ?? '') + data)
    void flushTerminalInput(sessionId)
  }

  /**
   * Follow the blocks: where each is on screen, and what size it now stands for.
   *
   * The rects are in viewport coordinates, the same arithmetic the documentation card uses,
   * so an overlay pans and zooms with its shape. The grid is in *scene* units, so a pinch
   * is not a resize — what the reader resized is the block, and that is what the server is
   * told about.
   *
   * Every session in a block is told, not just the tab on top. They all draw into the same
   * frame, so a background tab left at the size it had when it was hidden would repaint to
   * the wrong width the moment it came back.
   */
  const syncTerminalBlocks = (
    elements: readonly ExcalidrawElement[] | undefined,
    appState: Record<string, any> | undefined
  ): void => {
    if (!appState || !elements) {
      if (terminalViewsRef.current !== '') { terminalViewsRef.current = ''; setTerminalViews([]) }
      return
    }

    const suppressed = Boolean(
      appState.selectedElementsAreBeingDragged ||
      appState.isRotating ||
      appState.resizingElement
    )
    const zoom = appState.zoom?.value ?? 1

    const views: TerminalView[] = []
    for (const element of elements) {
      if (element.isDeleted || !isTerminalElement(element)) continue
      const data = terminalBlockData(element.customData)
      if (data.sessions.length === 0) continue

      const [minX, minY, maxX, maxY] = getCommonBounds([element])
      const topLeft = sceneCoordsToViewportCoords({ sceneX: minX, sceneY: minY }, appState as any)
      const bottomRight = sceneCoordsToViewportCoords({ sceneX: maxX, sceneY: maxY }, appState as any)
      views.push({
        elementId: element.id,
        rect: {
          x: topLeft.x - appState.offsetLeft,
          y: topLeft.y - appState.offsetTop,
          width: bottomRight.x - topLeft.x,
          height: bottomRight.y - topLeft.y
        },
        zoom,
        // Hidden mid-gesture, the way the documentation card is: a DOM overlay lags a shape
        // being dragged by a frame, which reads as the terminal coming loose from its block.
        suppressed,
        sessions: data.sessions,
        active: data.active
      })

      // Where this block is, kept for the two paths that need a shape's size after nothing
      // is about to report about it: a font change, and a block that has been erased.
      const geometry = { x: element.x, y: element.y, width: element.width, height: element.height }
      terminalGeometryRef.current.set(element.id, { ...geometry, sessions: data.sessions })
      for (const sessionId of data.sessions) terminalHomesRef.current.set(sessionId, geometry)

      reportTerminalGrid(element.id, geometry, data.sessions)
    }

    // Blocks that were on the board a moment ago and are not now. An eraser dragged across
    // one is the case this exists for; a delete and a select-all-and-clear are the same
    // event as far as this is concerned.
    const drawn = new Set(views.map((view) => view.elementId))
    let lost = false
    for (const elementId of terminalGeometryRef.current.keys()) {
      if (drawn.has(elementId)) continue
      terminalGeometryRef.current.delete(elementId)
      lost = true
    }
    // Also a session that has never had a block: one opened in another window arrives over
    // the socket, and the reconcile that follows it is the same reconcile.
    const homed = new Set(views.flatMap((view) => view.sessions))
    const stranded = Object.entries(terminalSessionsRef.current)
      .some(([sessionId, session]) => !session.ended && !homed.has(sessionId))
    if (lost || stranded) scheduleTerminalRestore()

    const signature = JSON.stringify(views)
    if (signature === terminalViewsRef.current) return
    terminalViewsRef.current = signature
    setTerminalViews(views)
  }

  /**
   * Tell the shells in one block what grid it now stands for.
   *
   * Three things move it: the corner being dragged, the `+` and `-` on the header, and a tab
   * arriving in a block of a different size. They are the same event as far as a shell is
   * concerned — the screen it repaints into got bigger or smaller — so they share one route,
   * one debounce and one retry.
   *
   * Reported on the end of the gesture rather than during it: a resize crosses every size
   * between where it started and where it lands, and reporting each one would be a request
   * per frame. A run of clicks on `+` coalesces the same way.
   *
   * Every session in the block, not just the tab on top. They all draw into the same frame,
   * so a background tab left at the size it had when it was hidden would repaint to the
   * wrong width the moment it came back.
   */
  const reportTerminalGrid = (
    elementId: string,
    size: { width: number; height: number },
    sessions: string[]
  ): void => {
    // Measured here rather than remembered: a row is the font's own line box times the line
    // height the emulator was given, and only the browser that resolved the font knows the
    // first of those. See `frontend/src/terminal-metrics.ts`.
    const font = terminalFontRef.current
    const grid = terminalGrid(size, font, terminalLineBox(font))
    const signature = `${grid.cols}x${grid.rows}`
    const stale = sessions.filter((id) => terminalGridRef.current.get(id) !== signature)
    if (stale.length === 0) return
    stale.forEach((id) => terminalGridRef.current.set(id, signature))

    const pending = terminalResizeTimersRef.current.get(elementId)
    if (pending) clearTimeout(pending)

    // A report that does not land is undone rather than forgotten. The signature stands
    // for "the server knows this size", so leaving it set after a failed request would
    // mean the block never mentions that size again — and with a PTY behind the session
    // that is not a stale label any more, it is a shell repainting to a width the block no
    // longer has.
    const report = (attempt: number): void => {
      terminalResizeTimersRef.current.delete(elementId)
      Promise.all(stale.map((sessionId) => fetch(apiUrl('/api/terminal/resize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...grid })
      }).then((response) => {
        if (!response.ok) throw new Error(`the terminal refused the new size: ${response.status}`)
      }))).catch(() => {
        // Only while this is still the size being reported: a later gesture has its own
        // request, and retrying an overtaken one would report a size nobody is looking at.
        if (stale.some((id) => terminalGridRef.current.get(id) !== signature)) return
        if (attempt >= 2) { stale.forEach((id) => terminalGridRef.current.delete(id)); return }
        terminalResizeTimersRef.current.set(
          elementId,
          setTimeout(() => report(attempt + 1), TERMINAL_RESIZE_DEBOUNCE_MS)
        )
      })
    }
    terminalResizeTimersRef.current.set(
      elementId,
      setTimeout(() => report(1), TERMINAL_RESIZE_DEBOUNCE_MS)
    )
  }

  /**
   * The reader moved the text, from the buttons on a block's header.
   *
   * Clamped here, once, rather than in the arithmetic: `terminalGrid` answers about the
   * font it is given, and holding a size down inside it would report a grid nobody chose.
   * The size is one preference for the page rather than one per block — it is about the
   * reader's eyes, and the same eyes read every tab.
   */
  const changeTerminalFont = (next: number): void => {
    const size = clampTerminalFont(next)
    setTerminalFont((current) => (current === size ? current : size))
  }

  // Remembered, and every block's grid re-derived from the shape it is already on. A font
  // change is a resize the reader did not drag: the blocks kept their size and the screens
  // inside them did not, so the shells have to be told the way a corner drag tells them.
  useEffect(() => {
    terminalFontRef.current = terminalFont
    try {
      window.localStorage?.setItem(TERMINAL_FONT_STORAGE_KEY, String(terminalFont))
    } catch (error) {
      console.warn('Failed to save the terminal font size to localStorage:', error)
    }
    for (const [elementId, block] of terminalGeometryRef.current) {
      reportTerminalGrid(elementId, block, block.sessions)
    }
    // Only the font: this is what the reader changed, and a block's own size arrives
    // through `syncTerminalBlocks` with its own report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalFont])

  // The board's sessions are adopted when the board is shown, and one is opened if it has
  // none. Nothing is closed on the way out: a terminal you switched away from keeps its
  // shells and their transcripts, and the server closes every session when it goes down.
  //
  // Behind `boardReady` for the reason that flag exists: until the board has been resolved
  // this runs as `default`, and opening a shell for a board nobody asked for is worse here
  // than the wasted socket it was introduced for — it is a process.
  useEffect(() => {
    if (!excalidrawAPI || !boardReady) return
    terminalGridRef.current.clear()
    // The next board's blocks are not this one's, and a restore there must measure the
    // content rather than reuse where the reader dragged a different project's.
    terminalGeometryRef.current.clear()
    terminalHomesRef.current.clear()
    writeTerminalSessions(() => ({}))
    terminalViewsRef.current = ''
    setTerminalViews([])
    // The ref, not the state: it is what `apiUrl` puts on every request, so it is the board
    // the guard has to be about.
    void adoptTerminalSessions(activeWorkspaceRef.current)
  }, [activeWorkspace, excalidrawAPI, boardReady])

  useEffect(() => {
    return () => {
      for (const timer of terminalResizeTimersRef.current.values()) clearTimeout(timer)
      terminalResizeTimersRef.current.clear()
      if (terminalRestoreTimerRef.current) clearTimeout(terminalRestoreTimerRef.current)
    }
  }, [])

  // On `window`, for the reason Alt+B is: Excalidraw never sees a key pressed outside its
  // canvas, and the point of this one is to work from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== TERMINAL_HOTKEY_CODE || !event.altKey || event.ctrlKey || event.metaKey) return

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

      // The key answers every way the terminal can be absent, which is what #93 asked of it
      // and what the tabs added one more of: never opened, every shell exited, the last tab
      // closed and the block gone with it, or a board whose own attempt to open one failed.
      // All of them are answered by asking for a session — and it never stands down on a
      // count it read once, because a key that is inert exactly when a reader reaches for it
      // is the complaint itself.
      const running = Object.values(terminalSessionsRef.current).some((session) => !session.ended)
      if (!running) {
        void openTerminalSession().then(() => reconcileTerminalBlocks({ scroll: true }))
        return
      }
      reconcileTerminalBlocks({ scroll: true })
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

  // The board's own keys — one per section it has drawn a mark around.
  //
  // Alt+B and Alt+T above are constants because a mirror and a terminal are features of
  // every board. Sections are not: they are how one project chose to cut its own
  // documentation, so the key is read off the shape (`src/core/board-sections.ts`) and a
  // board that draws no sections binds nothing at all. Same guards as Alt+B, and the same
  // reason for `window`: a key pressed outside the canvas is one Excalidraw never sees.
  //
  // Resolved on the keypress rather than kept in state: a section is a shape like any
  // other, so it can be drawn, retitled or deleted while the page is open, and one pass
  // over the scene per Alt+key costs nothing next to being wrong about what is on it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return

      const active = document.activeElement as HTMLElement | null
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) {
        return
      }

      const api = excalidrawAPIRef.current
      if (!api) return
      if ((api.getAppState() as unknown as Record<string, unknown>).editingTextElement) return

      const elements = api.getSceneElements()
      const { bindings } = resolveBoardSectionHotkeys(elements as unknown as BoardSectionElement[])
      const bound = bindings.find((binding) => binding.code === event.code)
      if (!bound) return

      const section = elements.find((element) => element.id === bound.elementId)
      if (!section) return

      event.preventDefault()
      api.scrollToContent([section] as unknown as ExcalidrawElement[], {
        fitToViewport: true,
        animate: true
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * Enter finishes writing an issue block.
   *
   * Writing an observation is typing into Excalidraw's own bound-label editor, and that
   * editor commits on exactly two keys: Escape, and Ctrl/Cmd+Enter. Plain Enter matches
   * neither, falls through to the textarea and inserts a newline — so the one key a reader
   * reaches for to say "done" is the one key that does not. There is no prop or callback
   * that changes it; the handler is `editable.onkeydown`, assigned as an element property
   * inside `textWysiwyg`.
   *
   * On `document`, in the capture phase, for the same reason the panel's Ctrl+V is: an
   * element-property handler runs at the target phase, so capturing at `document` is what
   * gets there first, and stopping the event is what keeps the newline from being typed.
   *
   * **So a selected issue block changes what Enter does on the canvas**, exactly as it
   * changes what Ctrl+V does, and the bounds are drawn to match:
   *
   * - only an issue block — every other label on the board keeps Enter as a newline;
   * - Shift+Enter is left alone, which is where the line break went;
   * - Escape and Ctrl/Cmd+Enter are left alone; removing a keystroke people already have
   *   in their fingers buys nothing;
   * - a composition in progress is left alone, or Enter-to-confirm an IME candidate would
   *   close the editor mid-word.
   *
   * **It finishes the edit; it does not start the run.** Starting the agent is an
   * unattended process with repository access, and inferring that from a key that means
   * "done writing" would be a guess with consequences. The button on the card stays the
   * only way in.
   *
   * The finish is a synthetic Escape dispatched at the textarea rather than a `blur()`,
   * because `onSubmit` re-selects the container only when the submit came from the
   * keyboard: blurring commits the text and leaves nothing selected, which closes the card
   * the reader wants next. It does not bubble — the editor's own handler is all this needs
   * to reach, and an Escape loose on the page is a different keystroke with its own
   * meanings.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter') return
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.isComposing || event.keyCode === 229) return

      const target = event.target as HTMLElement | null
      if (!target || target.tagName !== 'TEXTAREA' || !target.classList.contains('excalidraw-wysiwyg')) return

      const api = excalidrawAPIRef.current
      if (!api || !editingIssueBlock(api)) return

      event.preventDefault()
      event.stopPropagation()
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: false, cancelable: true
      } as KeyboardEventInit))
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [])

  /**
   * Which board, and only then the socket.
   *
   * The order is the point. The socket used to be opened on mount, before anything knew
   * which boards existed, so it declared `?workspace=default` — a board nobody is looking
   * at. `/api/workspaces` then landed and *switched*, which meant a second connection, a
   * second round of loading, and a canvas that went blank in between. Every load paid it.
   *
   * A registry that cannot be read is not a reason to sit there: the board falls back to
   * the default store, which is exactly what a single-board setup runs on anyway.
   */
  useEffect(() => {
    let cancelled = false

    const openTheBoard = async (): Promise<void> => {
      let list: WorkspaceSummary[] = []
      let configured = false
      try {
        const result = await (await fetch('/api/workspaces')).json()
        if (result?.success) {
          list = result.workspaces ?? []
          configured = Boolean(result.configured)
        }
      } catch (error) {
        console.warn('Could not load workspaces:', error)
      }
      if (cancelled) return

      setWorkspaces(list)
      setWorkspacesConfigured(configured)
      const resolved = resolveInitialWorkspace(list)
      if (resolved) {
        activeWorkspaceRef.current = resolved
        setActiveWorkspace(resolved)
        rememberWorkspace(resolved)
      }
      boardReadyRef.current = true
      setBoardReady(true)
      connectWebSocket()
    }

    void openTheBoard()

    return () => {
      cancelled = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      stopHeartbeat()
      if (websocketRef.current) {
        // 1000, and the handler dropped first: an unmount is not a dropped connection,
        // and letting the close path run would schedule a reconnect for a page that is
        // no longer there.
        websocketRef.current.onclose = null
        websocketRef.current.close(1000)
        websocketRef.current = null
      }
    }
  }, [])

  // The socket's own initial message is what normally fills the canvas; this covers the
  // case where it arrived before Excalidraw was mounted to receive it. It is a no-op once
  // this board has been loaded on this connection, which is what keeps a refresh to one
  // round of requests instead of the five it used to make.
  useEffect(() => {
    if (!excalidrawAPI || !boardReady) return
    void loadExistingElements()
  }, [excalidrawAPI, boardReady, activeWorkspace, isConnected])

  /**
   * Switch boards.
   *
   * The scene used to be emptied here, on the reasoning that the new board's elements
   * arrive asynchronously and one project's shapes must not sit under another project's
   * tab. The cost was a canvas that went blank for the length of a reconnect, and a blank
   * canvas reads as data loss — which is how this arrived as a bug report. So the previous
   * board stays up until the new one lands, the pill says *Connecting*, and the swap is a
   * single replacement rather than an empty gap. What the old blanking was really
   * protecting against is autosync, and that is held off by name instead.
   */
  const switchWorkspace = (workspaceId: string): void => {
    if (workspaceId === activeWorkspaceRef.current) return

    activeWorkspaceRef.current = workspaceId
    setActiveWorkspace(workspaceId)
    rememberWorkspace(workspaceId)
    // Everything the panel holds, not just the document: switching boards with an issue
    // block selected would otherwise leave its card open over the new board.
    setSelectedDoc({ key: null, title: null })
    setIssue(null)
    setCollapsible(null)
    docsAnchorIdRef.current = null
    setDismissedAnchorId(null)
    lastSelectedIdRef.current = null
    // The mirror belongs to one project. Keeping the last board would let a stale set of
    // columns decide where a card dragged on the new board was dropped, and keeping where
    // that project's region was placed would anchor this one to the other board's content.
    projectBoardRef.current = { board: null, columns: [], errors: {}, implementing: {}, signature: '' }
    mirrorOriginRef.current = null

    pendingSceneWorkspaceRef.current = workspaceId
    holdAutoSyncForSwitch()

    // A socket belongs to one board for its lifetime, so switching means reconnecting.
    if (websocketRef.current) {
      websocketRef.current.onclose = null
      websocketRef.current.close()
      websocketRef.current = null
    }
    stopHeartbeat()
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    reconnectAttemptsRef.current = 0
    setConnectionState('connecting')
    connectWebSocket()
  }

  /**
   * A project the `+` has just registered.
   *
   * The list is replaced from the response rather than re-fetched, and the board switches
   * to the new tab in the same turn: the registry is read per request, so the entry is
   * already live, and a reload here would throw away every unsynced shape on the board
   * that was open.
   */
  const adoptWorkspace = (workspace: WorkspaceSummary, list: WorkspaceSummary[]): void => {
    setWorkspaces(list)
    setWorkspacesConfigured(true)
    setWorkspaceDialog(null)
    switchWorkspace(workspace.id)
  }

  // Reloaded per board: a project may ship its own shapes on top of the shared set.
  // Waits for the board to be resolved, or it would fetch the default board's library
  // first and the real one a moment later, every load.
  useEffect(() => {
    if (!boardReady) return
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
  }, [activeWorkspace, excalidrawAPI, boardReady])

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
        implementError: (custom.implementError as string) ?? null,
        implementStartedAt: (custom.implementStartedAt as string) ?? null,
        implementEndedAt: (custom.implementEndedAt as string) ?? null
      })
    }

    if (typeof custom.collapsed === 'boolean') {
      setCollapsible({ id: updated.id, collapsed: custom.collapsed })
    }
  }

  /** What one run of the loader is for: this board, over this connection. */
  const sceneKey = (): string => `${activeWorkspaceRef.current}#${connectionGenerationRef.current}`

  /**
   * Pull the board over HTTP.
   *
   * The socket's own `initial_elements` is what normally fills the canvas; this exists for
   * the case where that message arrived before Excalidraw was mounted to receive it. It
   * used to run on every change of either `excalidrawAPI` or `isConnected` *and* on every
   * `onopen`, which came to roughly five pulls of the whole board per refresh — each one
   * parsing and base64-decoding on the thread that has to repaint. It now runs once per
   * board per connection, and skips the files when the socket already brought them.
   */
  const loadExistingElements = async (): Promise<void> => {
    const key = sceneKey()
    if (loadedSceneKeyRef.current === key) return
    loadedSceneKeyRef.current = key
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
          // The store holds no terminal block — they are derived and never synced — and this
          // just replaced the scene with what the store holds.
          reconcileTerminalBlocks()
          finishBoardSwitch()
        }
      }

      // Scoped to the board, and skipped outright when the socket's initial message
      // already carried it: the unscoped version returned every dataURL the process
      // holds, for every board, which on a board full of screenshots is megabytes.
      if (filesFromSocketRef.current !== key) {
        const filesResponse = await fetch(apiUrl('/api/files'))
        if (filesResponse.ok) {
          const filesResult = await filesResponse.json() as ApiResponse
          if (filesResult.files) {
            excalidrawAPI?.addFiles(Object.values(filesResult.files))
          }
        }
      }
    } catch (error) {
      console.error('Error loading existing elements:', error)
      // A failed pull is worth retrying on the next trigger; a successful one is not.
      if (loadedSceneKeyRef.current === key) loadedSceneKeyRef.current = null
    }
  }

  const stopHeartbeat = (): void => {
    if (!heartbeatTimerRef.current) return
    clearInterval(heartbeatTimerRef.current)
    heartbeatTimerRef.current = null
  }

  /**
   * Ask the socket, periodically, whether anything is still on the other end.
   *
   * The answer is due before the next question. One unanswered ping closes the socket —
   * which is the point: `readyState` says OPEN for a half-open connection until TCP times
   * it out, and until then the pill reads Connected over a board that has stopped
   * receiving anything. Closing hands it to the reconnect path, which is fast.
   */
  const startHeartbeat = (socket: WebSocket): void => {
    stopHeartbeat()
    awaitingPongRef.current = false
    heartbeatTimerRef.current = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (awaitingPongRef.current) {
        stopHeartbeat()
        socket.close(4000, 'heartbeat timeout')
        return
      }
      awaitingPongRef.current = true
      try {
        socket.send(JSON.stringify({ type: 'ping' }))
      } catch (error) {
        console.warn('Heartbeat could not be sent:', error)
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  /**
   * Try again, soon and then progressively less often.
   *
   * The first retry is immediate. The overwhelmingly common reason a socket drops here is
   * a canvas server that just restarted, and it is back in milliseconds — the flat three
   * seconds this replaces was spent entirely on a board that was already able to connect.
   * Past that it doubles from 250 ms to a five-second ceiling, so a server that is really
   * gone is not being hammered.
   */
  const scheduleReconnect = (): void => {
    if (reconnectTimerRef.current) return
    const attempt = reconnectAttemptsRef.current
    reconnectAttemptsRef.current = attempt + 1
    const delay = attempt === 0
      ? 0
      : Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_CAP_MS)
    setConnectionState(attempt >= RECONNECT_PATIENCE ? 'disconnected' : 'connecting')
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      connectWebSocket()
    }, delay)
  }

  const connectWebSocket = (): void => {
    // Nothing connects before the board is known: a socket opened now would declare the
    // default board and have to be replaced, which is the defect this all comes from.
    if (!boardReadyRef.current) return

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

    connectionGenerationRef.current += 1
    const socket = new WebSocket(wsUrl)
    websocketRef.current = socket

    socket.onopen = () => {
      reconnectAttemptsRef.current = 0
      setConnectionState('connected')
      startHeartbeat(socket)

      // The ref, not the closure: this handler was created before Excalidraw mounted on
      // the very load it matters for, and the closure would still say it had not.
      if (excalidrawAPIRef.current) {
        setTimeout(() => { void loadExistingElements() }, 100)
      }
    }

    socket.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        if ((data as { type?: string }).type === 'pong') {
          awaitingPongRef.current = false
          return
        }
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }

    socket.onclose = (event: CloseEvent) => {
      stopHeartbeat()
      if (websocketRef.current === socket) websocketRef.current = null
      if (event.code !== 1000) {
        scheduleReconnect()
      } else {
        setConnectionState('disconnected')
      }
    }

    socket.onerror = (error: Event) => {
      // Not a state change: an error is always followed by a close, and that is where the
      // decision between "retrying" and "offline" belongs.
      console.error('WebSocket error:', error)
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
        case 'initial_elements': {
          // A board switch leaves the previous board on screen until this arrives, so this
          // is the moment it is replaced — including with nothing, when the board being
          // switched to is empty. Outside a switch an empty payload is left alone, because
          // there it would mean wiping the canvas on a reconnect that raced the store.
          const landingOnANewBoard = pendingSceneWorkspaceRef.current !== null
          if (data.elements && data.elements.length > 0) {
            const cleanedElements = data.elements.map(cleanElementForExcalidraw)
            const convertedElements = convertElementsPreservingImageProps(cleanedElements)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: convertedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          } else if (landingOnANewBoard) {
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: [],
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          // Load files for image elements. The socket brought them, so the loader need not
          // ask for them again over HTTP.
          if ((data as any).files) {
            excalidrawAPI.addFiles(Object.values((data as any).files))
            filesFromSocketRef.current = sceneKey()
          }
          if (landingOnANewBoard) finishBoardSwitch()
          // The scene was just replaced wholesale, and the terminal's blocks are derived, so
          // the store this arrived from has never heard of them. Put them back.
          reconcileTerminalBlocks()
          break
        }

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

        // Every live session, sent the moment this socket connected. Authoritative rather
        // than additive: a session that ended while the tab was disconnected is absent from
        // this list, and reconciling against it is what takes its tab off the block.
        case 'terminal_sessions': {
          const listed: Record<string, any>[] = Array.isArray((data as any).sessions)
            ? (data as any).sessions
            : []
          writeTerminalSessions((current) => Object.fromEntries(listed.map((entry) => {
            const session = entry?.session ?? {}
            const output = typeof entry?.scrollback === 'string' ? entry.scrollback : ''
            return [session.id, {
              status: terminalStatusOf(session),
              // The replay, whole: it is a transcript rather than an increment. Kept only
              // when this tab has nothing longer of its own, which it does when the socket
              // dropped and came back while output was still arriving.
              output: (current[session.id]?.output ?? '').startsWith(output)
                ? current[session.id]!.output
                : output,
              ended: current[session.id]?.ended ?? null
            }]
          })))
          reconcileTerminalBlocks()
          break
        }

        case 'terminal_session': {
          const session = (data as any).session ?? null
          if (!session?.id) break
          writeTerminalSessions((current) => ({
            ...current,
            [session.id]: {
              status: terminalStatusOf(session),
              output: typeof (data as any).scrollback === 'string' ? (data as any).scrollback : '',
              ended: null
            }
          }))
          reconcileTerminalBlocks()
          break
        }

        case 'terminal_output': {
          const sessionId = (data as any).sessionId
          writeTerminalSessions((current) => (
            current[sessionId] === undefined
              ? current
              : {
                ...current,
                [sessionId]: {
                  ...current[sessionId]!,
                  output: `${current[sessionId]!.output}${(data as any).data ?? ''}`
                }
              }
          ))
          break
        }

        case 'terminal_resized': {
          const sessionId = (data as any).sessionId
          writeTerminalSessions((current) => {
            const session = current[sessionId]
            if (!session?.status) return current
            return {
              ...current,
              [sessionId]: {
                ...session,
                status: {
                  ...session.status,
                  cols: (data as any).cols ?? session.status.cols,
                  rows: (data as any).rows ?? session.status.rows
                }
              }
            }
          })
          break
        }

        case 'terminal_exit': {
          // The tab stays on the block and says what happened. Removing it would answer a
          // shell that exited by taking the evidence away; the `x` is how it goes.
          const sessionId = (data as any).sessionId
          writeTerminalSessions((current) => (
            current[sessionId] === undefined
              ? current
              : {
                ...current,
                [sessionId]: {
                  ...current[sessionId]!,
                  ended: `the shell exited${(data as any).code === null || (data as any).code === undefined
                    ? ''
                    : ` with code ${(data as any).code}`}`
                }
              }
          ))
          break
        }

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
    // Refused, not dropped: `releaseAutoSyncSuppression` comes back to it. Returning
    // without this is #92 — the change is left with no timer behind it and nothing that
    // would ever arm one.
    if (suppressAutoSyncCountRef.current > 0) {
      autoSyncPendingRef.current = true
      return
    }
    autoSyncPendingRef.current = false
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
    }

    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null
      // Suppressed by the time it fired: the debounce it waited out is spent, so the write
      // is owed again rather than forgotten.
      if (suppressAutoSyncCountRef.current > 0) {
        autoSyncPendingRef.current = true
        return
      }
      // A sync already on the wire cannot be assumed to carry this change — it read the
      // scene before it. Wait out another debounce rather than returning, which is the same
      // silent loss one branch up.
      if (syncInFlightRef.current) {
        scheduleAutoSync()
        return
      }
      // Nothing is owed once this runs: it writes the scene as it stands, which is every
      // change that was refused while the timer was out.
      autoSyncPendingRef.current = false
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
        configured={workspacesConfigured}
        onSelect={switchWorkspace}
        onAdd={() => setWorkspaceDialog('add')}
        onConfigure={() => setWorkspaceDialog('config')}
      />

      {workspaceDialog === 'add' && (
        <AddWorkspaceDialog
          onClose={() => setWorkspaceDialog(null)}
          onAdded={adoptWorkspace}
        />
      )}

      {workspaceDialog === 'config' && (
        <WorkspaceConfigDialog
          workspaceId={activeWorkspace}
          onClose={() => setWorkspaceDialog(null)}
          // Only the list is replaced: the board is already showing this project, so
          // switching to it again would empty the scene and reconnect for nothing.
          onSaved={(_workspace, list) => { setWorkspaces(list); setWorkspaceDialog(null) }}
        />
      )}

      {/* Header */}
      <div className="header">
        <h1>Excalidraw Canvas</h1>
        <div className="controls">
          {/*
            Three states, not two. A socket that has never been up is *connecting*, and
            reporting that as Disconnected is what made a refresh look like an outage.
          */}
          <div className="status">
            <div className={`status-dot status-${connectionState}`}></div>
            <span>
              {connectionState === 'connected' ? 'Connected'
                : connectionState === 'connecting' ? 'Connecting…'
                  : 'Disconnected'}
            </span>
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
              reportSectionClaims(_elements)
              // Order matters: syncSelectedDoc settles which shape is anchored, and this
              // then works out where that shape is.
              syncDocsAnchor(_elements, appState as unknown as Record<string, any>)
              // Same arithmetic, one overlay per block: each terminal follows its own shape
              // wherever the board is panned, zoomed or that shape dragged to.
              syncTerminalBlocks(_elements, appState as unknown as Record<string, any>)
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

          {/* Also siblings of the canvas, and for the same reason: a transcript is not a
              scene element, so it cannot be exported, synced or committed. One per block,
              because a block is a strip of tabs and there may be several on the board. */}
          {terminalViews.map((view) => (
            <TerminalPanel
              key={view.elementId}
              rect={view.rect}
              zoom={view.zoom}
              suppressed={view.suppressed}
              tabs={view.sessions
                .filter((sessionId) => terminalSessions[sessionId])
                .map((sessionId) => ({ id: sessionId, ...terminalSessions[sessionId]! }))}
              activeId={view.active}
              canAdd={Object.keys(terminalSessions).length < terminalLimit}
              canMerge={terminalViews.length > 1}
              onSelect={(sessionId) => selectTerminalTab(view.elementId, sessionId)}
              onAdd={() => { void openTerminalSession(view.elementId) }}
              onClose={(sessionId) => { void closeTerminalSession(sessionId) }}
              onDetach={(sessionId) => detachTerminalSession(view.elementId, sessionId)}
              onMerge={() => mergeTerminalBlock(view.elementId)}
              onInput={sendTerminalInput}
              fontSize={terminalFont}
              onFontSize={changeTerminalFont}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default App
