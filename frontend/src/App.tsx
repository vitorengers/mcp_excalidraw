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
import { canvasFontsReady } from './canvas-fonts'
import { CollapsibleTarget, CommentPosted, IssueTarget } from './components/DocsPanel'
import { AnchoredDocsPanel } from './components/AnchoredDocsPanel'
import type { Rect } from '../../src/core/anchored-placement'
import { resolvePanelTarget } from '../../src/core/panel-target'
import type { PanelElement } from '../../src/core/panel-target'
import {
  describeIgnoredClaims, firstBoardSection, resolveBoardSectionHotkeys
} from '../../src/core/board-sections'
import type { BoardSectionElement } from '../../src/core/board-sections'
import {
  describeIgnoredSubsectionClaims, resolveBoardSubsections, stepBetweenSubsections
} from '../../src/core/board-subsections'
import { isBoardHotkeyChord, textEntryOwnsKeyboard } from './board-hotkeys'
import { boardFitOptions, measureBoardChrome } from './board-fit'
import { referenceImageName } from '../../src/core/pasted-images'
import { layoutLabel, BOUND_TEXT_PADDING } from '../../src/core/text-layout'
import {
  layoutMirror,
  mirrorWidth,
  columnAt,
  mirrorAnchors,
  resolveMirrorOrigin,
  layoutUnreadable,
  UNREADABLE_WIDTH,
  MIRROR_KIND,
  NOTES_OPTION_ID
} from '../../src/core/project-board-layout'
import type { CardImplementState, DraftBlock, MirrorColumn } from '../../src/core/project-board-layout'
import type { ProjectBoard } from '../../src/core/project-board-types'
import { TerminalPanel } from './components/TerminalPanel'
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_GRID,
  TERMINAL_KIND,
  clampTerminalFont,
  terminalBlockData,
  terminalBlockElement,
  terminalGrid,
  terminalOrigin,
  terminalSizeFor,
  documentationClearance
} from '../../src/core/terminal-block'
import type { Bounds } from '../../src/core/terminal-block'
import { terminalAdvance, terminalFontReady, terminalLineBox } from './terminal-metrics'
import { WorkspaceTabs, WorkspaceSummary } from './components/WorkspaceTabs'
import { AddWorkspaceDialog, WorkspaceConfigDialog } from './components/WorkspaceDialogs'
import { ClaudeStatusHud } from './components/ClaudeStatusHud'
import { RestartButton } from './components/RestartButton'
import type { ClaudeEnvironmentStatus } from './components/ClaudeStatusHud'
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

/**
 * What the server says about this board's implementation queue.
 *
 * `column` is a name rather than an option id: the server resolves it from the workspace's
 * own `projectTodoColumn`, and it has no board in hand to turn into an id without spending a
 * `gh` process on every poll. The canvas already has the sections, so it does the matching.
 */
interface ImplementQueueState {
  enabled: boolean;
  column: string;
  /**
   * On, and the last pass could not start what it was switched on to start.
   *
   * The one bit the toggle draws. The reason itself is a sentence the server composed — the
   * cap and who is holding it, a column that is not on the project, a board that could not be
   * read — and it is said as a toast rather than drawn, because a button twenty-eight pixels
   * across has room for a broken outline and not for a paragraph.
   */
  stalled: boolean;
  /** Why, in words the reader can act on. Empty when the queue has no pass to report. */
  reason: string;
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
const AUTO_SYNC_DEBOUNCE_MS = 1200;

/**
 * What this page calls itself, on its socket and on the writes it sends over HTTP.
 *
 * The two are separate connections and nothing tied them together, so a write came back to
 * its own author as an `element_updated` carrying the server's whole copy of the element —
 * merged over the live scene field by field, a debounce behind whatever was being typed
 * (#190). Named on both, the server can leave the author out and still tell every other
 * browser on the board.
 *
 * Per page load rather than per board: it identifies the connection, not the reader, and a
 * board switch reconnects. `randomUUID` needs a secure context, which a board reached over
 * plain HTTP on a LAN address is not, so the fallback is not decorative.
 */
const CLIENT_ID = globalThis.crypto?.randomUUID?.()
  ?? `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * What this tool is called, for the one place the frontend has to say it.
 *
 * `board.config.json`'s `name`, copied rather than imported: that file is the server's, read
 * per request for whichever project a tab is showing, and a bundle that runs before the first
 * response has no board to read it from. The copy in `frontend/index.html`'s `<title>` is
 * there for the same reason and is even earlier — it is what a still-loading tab says.
 * `scripts/check-brand-strings-browser.mjs` holds all three in agreement, the way
 * `check-readme.mjs` already does for the README.
 */
const PRODUCT_NAME = 'VibeMaxxing';

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
 * How often the header re-reads what Claude Code has spent.
 *
 * A minute, which is what the observation asked for and is a ceiling rather than a promise:
 * the figures underneath are only as fresh as the last session that ran a status line, so
 * polling faster would buy nothing and reading the directory more often would cost the same
 * files. Slower than the mirror above deliberately — that one is watching a board somebody
 * else can move, this one is watching a file this machine writes.
 */
const CLAUDE_STATUS_POLL_MS = 60000;

/**
 * `?claudeStatusPollMs=` on the board's own URL, for a reader who wants it slower.
 *
 * Clamped rather than trusted: `0` would be a busy loop against the disk and a very large
 * number would be a HUD that never moves again. Read from the query string rather than
 * given an environment variable of its own because it is this page's cadence, not the
 * server's, and the server's own variable is the one that decides whether any of this
 * exists at all.
 */
function claudeStatusPollMs(): number {
  const asked = Number(new URLSearchParams(window.location.search).get('claudeStatusPollMs'))
  if (!Number.isFinite(asked) || asked <= 0) return CLAUDE_STATUS_POLL_MS
  return Math.min(600000, Math.max(200, asked))
}

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
 * How long to wait before putting an erased block back.
 *
 * Not immediately: the erase arrives as a scene change, and re-placing the block inside the
 * handler for that change would put it under a pointer that is still erasing. Long enough
 * for the gesture to finish, short enough that the block reads as never having gone.
 */
const TERMINAL_RESTORE_DELAY_MS = 250;

/**
 * How long `flushAutoSync` waits for a sync already on the wire before giving up on it.
 *
 * A ceiling rather than a timeout that fails: past it the request is sent anyway, which is
 * what happened on every click before the flush existed. Generous against a slow store and
 * still short enough that a wedged sync does not make the button look dead.
 */
const FLUSH_WAIT_MS = 4000;
const FLUSH_POLL_MS = 50;

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

/**
 * Where the rect a board's terminal block was last left at is kept.
 *
 * Per board, and that is the whole distinction from the font above: how big the terminal is
 * and where it sits is a fact about a *project* — one wants a wide screen for an agent
 * transcript, another wants it out of the way of a diagram — while the size of the text is a
 * fact about the reader's eyes, and the same eyes read every board.
 *
 * `localStorage` rather than `customData` for the same reason the font gives: the block is
 * derived and stripped at both doors, so a rect stored on the shape is dropped on the way to
 * the store and read as the block forgetting it. The cost is that a second browser, or a
 * second machine, viewing the same board gets its own arrangement — which is what every
 * other viewing preference here already does.
 */
const TERMINAL_GEOMETRY_STORAGE_KEY = 'excalidraw-terminal-geometry';

interface TerminalRect { x: number; y: number; width: number; height: number }

/**
 * One board's remembered rect, or `null` if it has none — or if what is stored is not one.
 *
 * Validated rather than trusted. This is a key anybody can edit and a stale one can outlive
 * the shape of what wrote it, and a block placed at `NaN` or at zero width is a shape
 * Excalidraw draws nowhere and no reader can find to drag back.
 */
const readTerminalGeometry = (workspace: string): TerminalRect | null => {
  try {
    const raw = window.localStorage?.getItem(TERMINAL_GEOMETRY_STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) ?? {})[workspace] : null;
    if (!stored || typeof stored !== 'object') return null;
    const { x, y, width, height } = stored as Record<string, unknown>;
    if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return null;
    }
    if ((width as number) <= 0 || (height as number) <= 0) return null;
    return { x: x as number, y: y as number, width: width as number, height: height as number };
  } catch (error) {
    console.warn('Failed to read the terminal geometry from localStorage:', error);
    return null;
  }
};

/** Remember one board's rect, leaving every other board's alone. */
const writeTerminalGeometry = (workspace: string, rect: TerminalRect): void => {
  try {
    const raw = window.localStorage?.getItem(TERMINAL_GEOMETRY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const stored = parsed && typeof parsed === 'object' ? parsed : {};
    window.localStorage?.setItem(
      TERMINAL_GEOMETRY_STORAGE_KEY,
      JSON.stringify({ ...stored, [workspace]: rect })
    );
  } catch (error) {
    console.warn('Failed to save the terminal geometry to localStorage:', error);
  }
};

/**
 * How far right the documentation currently stands from where its board authored it.
 *
 * Kept because the page cannot work it out again by looking. The shift is a real element
 * move — it has to be, or it would not survive the reload the definition of done names — and
 * once it has been written the pushed board and the board at rest are the same picture: the
 * first block sits exactly one gap left of the documentation in both, because that is where
 * `terminalOrigin` puts it. Geometry therefore cannot say which of the two a scene is, and a
 * page that guessed would either push twice or never put it back.
 *
 * So the number is written down, per board, beside the terminal's own rect and for the same
 * reason (#154): the door out of a page is a reload, and this has to be on the other side of
 * it. The shift is always synced along with the move that caused it, so what the store holds
 * and what this says are one answer rather than two.
 *
 * A board whose key is missing — another browser, a cleared profile — reads zero, which says
 * "what you can see is where the board authored it". That is the safe direction: it pushes
 * from wherever the content stands rather than from a home it cannot know, and the worst it
 * costs is a documentation that stays where the last session's shells left it.
 */
const DOCUMENTATION_SHIFT_STORAGE_KEY = 'excalidraw-documentation-shift';

const readDocumentationShift = (workspace: string): number => {
  try {
    const raw = window.localStorage?.getItem(DOCUMENTATION_SHIFT_STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) ?? {})[workspace] : null;
    // Validated rather than trusted, like the rect beside it: a key anybody can edit, and a
    // `NaN` here would move every authored shape on the board to nowhere.
    return typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 ? stored : 0;
  } catch (error) {
    console.warn('Failed to read the documentation shift from localStorage:', error);
    return 0;
  }
};

/** Remember one board's shift, leaving every other board's alone. */
const writeDocumentationShift = (workspace: string, shift: number): void => {
  try {
    const raw = window.localStorage?.getItem(DOCUMENTATION_SHIFT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const stored = parsed && typeof parsed === 'object' ? parsed : {};
    window.localStorage?.setItem(
      DOCUMENTATION_SHIFT_STORAGE_KEY,
      JSON.stringify({ ...stored, [workspace]: shift })
    );
  } catch (error) {
    console.warn('Failed to save the documentation shift to localStorage:', error);
  }
};

/**
 * Where each board's camera is kept between visits to the page.
 *
 * Per board, for the reason the terminal's geometry is: where a project is being read from,
 * and how far in, is a fact about that project's drawing. It joins the theme, the menu
 * setting, the terminal's font and the terminal's geometry in `localStorage` — until #185 the
 * zoom was the one display setting on this page that did *not* survive a reload, which is what
 * turned "the board opens too small" into "if I dont zoom in": the correction had to be made
 * again on every refresh.
 */
const BOARD_VIEWPORT_STORAGE_KEY = 'excalidraw-board-viewports';

/** How long a camera has to sit still before it is written down. */
const VIEWPORT_SAVE_MS = 400;

interface BoardViewport { scrollX: number; scrollY: number; zoom: number }

const isViewport = (value: unknown): value is BoardViewport => {
  if (!value || typeof value !== 'object') return false;
  const { scrollX, scrollY, zoom } = value as Record<string, unknown>;
  if (![scrollX, scrollY, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  return (zoom as number) > 0;
};

/**
 * Every board's remembered camera, validated on the way in.
 *
 * Read once for the page: this is a key anybody can edit, and a stale one can outlive the
 * shape of what wrote it. A board restored to `zoom: 0` or to `NaN` is a canvas showing
 * nothing, with no shape on it to drag back into view.
 */
let storedViewports: Map<string, BoardViewport> | null = null;

const rememberedViewports = (): Map<string, BoardViewport> => {
  if (storedViewports) return storedViewports;
  storedViewports = new Map();
  try {
    const raw = window.localStorage?.getItem(BOARD_VIEWPORT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const [workspace, view] of Object.entries(parsed as Record<string, unknown>)) {
        if (isViewport(view)) {
          storedViewports.set(workspace, { scrollX: view.scrollX, scrollY: view.scrollY, zoom: view.zoom });
        }
      }
    }
  } catch (error) {
    console.warn('Failed to read the board viewports from localStorage:', error);
  }
  return storedViewports;
};

/**
 * Write every board this page knows about, over whatever is stored.
 *
 * The map it is given was seeded from the same key, so this loses nothing of another
 * session's — except a board a *second tab* parked after this one loaded, which is the cost
 * every viewing preference here already pays.
 */
const writeBoardViewports = (views: Map<string, BoardViewport>): void => {
  try {
    const raw = window.localStorage?.getItem(BOARD_VIEWPORT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const stored = parsed && typeof parsed === 'object' ? parsed : {};
    window.localStorage?.setItem(
      BOARD_VIEWPORT_STORAGE_KEY,
      JSON.stringify({ ...stored, ...Object.fromEntries(views) })
    );
  } catch (error) {
    console.warn('Failed to save the board viewports to localStorage:', error);
  }
};

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
 * The board's own documentation: the region the other two are placed from, and the one #200
 * makes the canvas move.
 *
 * Everything on the canvas that is neither derived nor standing inside the mirror. The
 * drafts are the part worth naming: they are authored — a real issue block, the reader's
 * until the issue exists — but they are laid out by `layoutMirror` into the notes column,
 * which puts them a whole mirror-width to the left of everything else here. Counted as
 * documentation they would drag its left edge out there with them, and both the block's
 * anchor and the room it asks for would be measured against a column of the mirror.
 *
 * A label goes with whatever it is bound to, which is the rule the sync and the export
 * already state: a text element carries no mark of its own, so on its own terms one bound to
 * a terminal block or to a draft looks authored.
 */
const documentationElements = <T extends {
  id: string; isDeleted?: boolean; customData?: CustomData; containerId?: string | null
}>(scene: readonly T[]): T[] => {
  const alive = scene.filter((element) => !element.isDeleted);
  const apart = new Set(
    alive.filter((element) => isDerivedElement(element) || isDraftBlock(element))
      .map((element) => element.id)
  );
  return alive.filter((element) => !apart.has(element.id)
    && !(element.containerId && apart.has(element.containerId)));
};

/** The box a set of plain rectangles covers, without asking Excalidraw about rotation. */
const boxOf = (elements: readonly { x: number; y: number; width: number; height: number }[]):
Bounds | null => {
  if (elements.length === 0) return null;
  return {
    minX: Math.min(...elements.map((element) => element.x)),
    minY: Math.min(...elements.map((element) => element.y)),
    maxX: Math.max(...elements.map((element) => element.x + element.width)),
    maxY: Math.max(...elements.map((element) => element.y + element.height)),
  };
};

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
 * Whether something is being worked on that a redraw would take out from under it.
 *
 * A card mid-drag, a shape mid-resize, one still being drawn, or a caret in a label. Asked
 * more than once per pass on purpose: a redraw that reads the board over `gh` first is
 * seconds away from the answer, and a reader can start typing inside those seconds — so the
 * question has to be put again immediately before the scene is written, not only before the
 * read that leads to it (#132).
 */
const busyOnCanvas = (api: ExcalidrawImperativeAPI): boolean => {
  const appState = api.getAppState() as unknown as Record<string, unknown>;
  return Boolean(appState.selectedElementsAreBeingDragged || appState.editingTextElement
    || appState.newElement || appState.resizingElement);
};

/**
 * Say something to whoever is looking at the board, and to whoever reads the log afterwards.
 *
 * A press on one of the mirror's buttons that cannot be served used to answer with a
 * `console.warn` and nothing else, which is indistinguishable from a button that does not
 * work — the reader has no console open, and the shape gives no sign either way (#244).
 * Excalidraw's own toast is a sibling of the canvas rather than something drawn into the
 * scene, so it says this without putting a shape on the board that would then have to be
 * cleaned up, exported around, or synced to anybody else.
 *
 * Ten seconds rather than the default five: this asks the reader to go and look at a
 * configuration file, which is not a thing to read in five.
 */
const sayOnCanvas = (api: ExcalidrawImperativeAPI, message: string): void => {
  console.warn(message);
  api.setToast({ message, closable: true, duration: 10000 });
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

/** One line of text, however it happens to have been wrapped. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The sentence the library ships inside its issue block, on one line.
 *
 * Read from the template rather than written out here for the reason the block itself is:
 * a second copy of it would drift from the library's the moment either changed, and this
 * one decides whether a block counts as written into.
 *
 * `instantiateIssueBlock` puts it through `layoutLabel`, which only inserts line breaks, so
 * a wrapped label and the template it came from are the same sentence. Comparing them on
 * one line is what makes the answer independent of the column's width — a block dropped
 * into a narrower column wraps differently and would otherwise read as edited.
 */
const draftPlaceholder = (template: LibraryElement[]): string | null => {
  const shape = template.find((element) => element?.customData?.kind === 'issue');
  if (!shape) return null;
  const label = template.find((element) => element.containerId === shape.id);
  return label ? oneLine(String(label.text ?? '')) : null;
};

/**
 * A draft nobody has written into and no run has claimed.
 *
 * Two questions, because "non-populated" stops being true in two ways. The label still
 * saying what the library put there is one. The other is a finished run: it writes
 * `issueUrl` and `issueState` onto the block, and that block is somebody's even though
 * nobody typed a character into it.
 *
 * Answered off the element rather than off a flag, deliberately. A flag is a second copy of
 * the answer that has to be kept in step with the text the reader is actually looking at,
 * and every place that could edit the text would have to remember to clear it.
 */
const isUnpopulatedDraft = (
  block: { id: string; customData?: CustomData },
  scene: readonly LabelledElement[],
  placeholder: string
): boolean => {
  const custom = customDataOf(block);
  if (custom.issueUrl || custom.issueState) return false;
  const label = scene.find((element) => element.containerId === block.id && element.type === 'text');
  if (!label) return false;
  // `originalText` is the text as typed; `text` is the same thing with Excalidraw's own
  // wrapping in it. Either answers this, and the first is preferred where it exists.
  return oneLine(String(label.originalText ?? label.text ?? '')) === placeholder;
};

/** A scene element read only for the label bound to it. */
interface LabelledElement {
  id: string;
  type?: string;
  containerId?: string | null;
  text?: string;
  originalText?: string;
  isDeleted?: boolean;
  customData?: CustomData;
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

/**
 * Grow a container that its own bound label no longer fits inside.
 *
 * Nothing in the browser ever made an issue block fit what is written into it. The library
 * ships a 400x140 template, `instantiateIssueBlock` takes that height verbatim, and the
 * height a long observation needs is on loan from Excalidraw's editor-only auto-grow — which
 * mutates the container in place and is therefore handed back by anything that writes the
 * scene from a copy taken before it. `applyIssueToBlock` applies `layoutLabel().containerHeight`
 * on the server (`src/server.ts`) and this is the same rule on this side, which is the side
 * that has the numbers: `layoutLabel` estimates text it cannot measure, and a label already
 * on the canvas has been measured by the browser.
 *
 * Without it `recenterBoundShapeTextElements` below centres a 220px label in a 140px box, so
 * half the overflow goes off the *top* of the block — the cut first lines in #190 — and the
 * canvas clips nothing, so it lands behind whatever is above.
 *
 * **Only ever grows.** A block is never made smaller than it was written at, so a short
 * observation keeps the template height it was placed with and no card in the mirror is
 * resized by a measurement that happened to come out under its own estimate. And only for a
 * label that is centred in its container, which is the case that puts text above the top
 * edge; a label pinned to the top overflows downwards and is left to whoever chose that.
 */
const fitContainersToBoundText = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  const needed = new Map<string, number>()
  for (const element of elements) {
    const label = element as Partial<ExcalidrawElement> & {
      containerId?: string | null; autoResize?: boolean
    }
    if (label.type !== 'text' || !label.containerId) continue
    if (label.autoResize === false) continue
    if (typeof label.height !== 'number') continue
    needed.set(label.containerId, Math.max(needed.get(label.containerId) ?? 0, label.height))
  }
  if (needed.size === 0) return elements

  return elements.map((element) => {
    const wanted = element.id ? needed.get(element.id) : undefined
    if (wanted === undefined || !isShapeContainerType(element.type)) return element
    const fits = wanted + BOUND_TEXT_PADDING * 2
    if (typeof element.height !== 'number' || element.height >= fits) return element
    // Excalidraw reconciles by version, so a shape whose height changed and whose version
    // stood still is one it may keep as it was.
    return { ...element, height: fits, version: (element.version ?? 1) + 1 }
  })
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
  // Fitted before it is centred: `recenterBoundShapeTextElements` divides the slack between
  // the top and the bottom, and a box too short for its text has slack to spare in both
  // directions. There has to be none left over before the halving.
  return recenterBoundShapeTextElements(fitContainersToBoundText(
    [...restoredNonImageElements, ...imageElements, ...freedrawElements]
  ))
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

/**
 * How many boards stay live behind the one on screen.
 *
 * The question #173 left open was which boards those are, and the answer here is: the ones
 * this reader has actually opened, up to this many. Every *registered* board would be a
 * socket per project whether or not anybody had ever looked at it, and on a machine with a
 * dozen projects registered that is a dozen connections paid for by nobody. Visiting a board
 * is the reader saying they are working on it.
 *
 * Four is a bound rather than a measurement: what a warm board costs is a socket and a second
 * copy of its scene, and the reader switching between two or three projects — which is the
 * observation this comes from — is well inside it. The board waited on longest goes cold past
 * the cap, which costs it nothing except the reconnect it used to pay on every single switch.
 */
const WARM_BOARD_LIMIT = 4

/**
 * A board kept live while another one is on screen.
 *
 * `elements` is the board's **scene**, not its store, and the difference is the point: the
 * mirror's cards and the terminal's blocks are derived and are in no store at all, so a copy
 * of the store would come back missing exactly the things that take a `gh` call and a shell
 * to put back. `tombstones` rides along for the reason `renderMirror` keeps it — a deletion
 * travels as an element marked deleted, and a redraw that dropped one would undo it.
 */
interface WarmBoard {
  socket: WebSocket
  elements: Partial<ExcalidrawElement>[]
  tombstones: Partial<ExcalidrawElement>[]
  /** Files that arrived while the board was in the background, added back when it returns. */
  files: unknown[]
  heartbeat: ReturnType<typeof setInterval> | null
  awaitingPong: boolean
  /** Visit order, so the cap drops the board the reader has been away from longest. */
  visitedAt: number
}

/** Where this browser remembers whether Excalidraw's own menus are hidden. */
const CHROME_STORAGE_KEY = 'excalidraw-canvas-chrome'

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

  /**
   * Whether Excalidraw's own chrome is hidden: the hamburger, the properties island that
   * appears beside a selected shape, and the toolbar.
   *
   * Kept here rather than on the server, and deliberately. This is what one reader is
   * looking at, not board state: sent to the store it would reach every other tab and every
   * other person on the board, and hide their menus because somebody else wanted the room.
   * `localStorage` is where the theme already keeps the same kind of setting, and it gives
   * the two things the observation asked for at once — one setting for every project tab in
   * this browser, and still there after a reload.
   *
   * Read as a string rather than as a boolean so that an absent key and a key saying
   * `visible` are the same thing: nothing changes for anyone who never presses the button.
   */
  const [chromeHidden, setChromeHidden] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage?.getItem(CHROME_STORAGE_KEY) === 'hidden'
    } catch (error) {
      console.warn('Failed to read the menu setting from localStorage:', error)
      return false
    }
  })

  /**
   * What each Claude Code environment on this machine has spent, per `GET /api/claude-status`.
   *
   * Empty until the first read answers, and empty for good on a board that was never
   * configured to look — the HUD draws nothing rather than drawing an empty frame, because a
   * row that says nothing is indistinguishable from a machine that has nothing to say.
   */
  const [claudeStatus, setClaudeStatus] = useState<ClaudeEnvironmentStatus[]>([])
  /** Settled once, at mount: the cadence cannot change without the URL changing. */
  const [claudeStatusPoll] = useState<number>(() => claudeStatusPollMs())

  // Boards, one per project
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<string>('default')
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

  /**
   * The board whose shapes are actually on the canvas.
   *
   * Not the same as `activeWorkspaceRef`, and the difference is a real window rather than a
   * technicality: a switch names the new board at once and leaves the old board's shapes up
   * until the new scene lands, so for the length of a reconnect the two disagree. Anything
   * derived from what is *drawn* has to follow the drawing — the terminal's cache of where
   * each block sits did not, and put one project's terminal on another project's board
   * (#156). Moved on by `finishBoardSwitch`, which is the moment the swap happened.
   */
  const sceneWorkspaceRef = useRef<string>('default')

  /** Append the active workspace to an API path, so no request is ever board-agnostic. */
  const apiUrl = (path: string): string => apiUrlOn(path, activeWorkspaceRef.current)

  /**
   * The same, for a board named rather than read off the ref at the moment of the call.
   *
   * `apiUrl` resolves late by design — a handler that never re-renders must not send a board
   * it closed over — but a request scheduled on a *timer* wants the opposite: the board it
   * was scheduled for. The terminal's resize report is debounced and retried, so read late
   * it could arrive at whichever board the reader had switched to in the meantime, naming a
   * session id that board has one of its own (#156).
   */
  const apiUrlOn = (path: string, workspaceId: string): string => {
    const separator = path.includes('?') ? '&' : '?'
    return `${path}${separator}workspace=${encodeURIComponent(workspaceId)}`
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
      // The block, and the observation just typed into it, before the id is sent anywhere:
      // the server resolves that id out of its own store, and the autosync is the only thing
      // that puts it there.
      await flushAutoSync()
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
   * Tell a block which issue it already produced.
   *
   * The way back from #118, where a run's result was overwritten by this browser's own
   * autosync and the block was left carrying nothing: not `running`, so the reset does not
   * apply; no `issueUrl`, so a run would open a *second* issue for an observation that
   * already has one. Deleting the block by hand was the only answer, and it takes the
   * observation with it.
   *
   * Nothing is guessed here. The server reads the issue through `gh` and refuses the URL if
   * it cannot, and what it then writes is what the end of a successful run writes — so the
   * block comes out indistinguishable from one whose result was recorded properly, and the
   * update arrives over the socket the same way.
   */
  const adoptIssueOnBlock = async (target: IssueTarget, issueUrl: string): Promise<string | null> => {
    try {
      // Addressed by element id, so the same rule as the run: the server has to have the
      // block before it is asked to write anything onto it.
      await flushAutoSync()
      const response = await fetch(apiUrl(`/api/issue-block/${target.id}/adopt`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueUrl })
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) return body?.error ?? `HTTP ${response.status}`
      return null
    } catch (error) {
      return (error as Error).message
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
      // Reachable as early as the run is — the block a lost run is being cleared from may
      // never have reached the store at all.
      await flushAutoSync()
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
    resume = false,
    interactive = false
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
        // Both flags are omitted rather than sent false, so a run nobody asked anything
        // about is the request this board has always sent.
        body: JSON.stringify({
          url: target.issueUrl,
          ...(resume ? { resume: true } : {}),
          ...(interactive ? { interactive: true } : {})
        })
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
   * Send an agent back at an issue that already exists, to rewrite it in place.
   *
   * Nothing on the element changes, and there is nothing to change: the surface this is
   * offered on is usually a mirrored card, which has no element at all. The run's state lives
   * on the server against the issue URL and the panel polls it — which is also why this
   * writes no optimistic state here, unlike implementing: there is no shape for a `running`
   * to be written onto.
   */
  const recreateIssue = async (
    target: IssueTarget,
    observations: string
  ): Promise<string | null> => {
    if (!target.issueUrl) return 'This block has no issue to research again yet.'

    try {
      // By issue URL, like implementing and commenting: a mirrored card has no element on the
      // server, and the issue is what is being rewritten either way.
      const response = await fetch(apiUrl('/api/issue/recreate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target.issueUrl, observations })
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        return body?.error ?? `HTTP ${response.status}`
      }
      return null
    } catch (error) {
      return (error as Error).message
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

  /**
   * Write a block's attached list, and mirror it into the panel and onto the block.
   *
   * Pasting a screenshot into the panel is one `PUT`, and it used to come back over the
   * socket as the server's whole copy of the block — which through a burst of typing is the
   * block as it was before it grew (#190). It does not any more, so the block's own copy of
   * the list is written here.
   */
  const writeIssueImages = async (elementId: string, images: string[]): Promise<void> => {
    const element = excalidrawAPI?.getSceneElements().find((candidate) => candidate.id === elementId)
    const customData = {
      ...(customDataOf(element as { customData?: CustomData }) ?? {}), issueImages: images
    }
    const response = await fetch(apiUrl(`/api/elements/${elementId}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-client-id': CLIENT_ID },
      body: JSON.stringify({ customData })
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body?.error ?? `HTTP ${response.status}`)
    }
    patchSceneElement(elementId, { customData } as unknown as Partial<ExcalidrawElement>)
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

    const written = {
      ...next,
      customData: { ...(element.customData ?? {}), collapsed: !isCollapsed, fullSize }
    }

    try {
      await fetch(apiUrl(`/api/elements/${elementId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-client-id': CLIENT_ID },
        body: JSON.stringify(written)
      })
      // The write no longer comes back over the socket, so the new size is applied here.
      patchSceneElement(elementId, written as unknown as Partial<ExcalidrawElement>)
      setCollapsible({ id: elementId, collapsed: !isCollapsed })
    } catch (error) {
      console.error('Could not toggle image collapse:', error)
    }
  }
  const lastSelectedIdRef = useRef<string | null>(null)

  /**
   * The stall sentence this board has already said, so it says each one once.
   *
   * A stalled queue stalls on a timer: the poll finds the same reason every twenty seconds,
   * and a toast per poll would be the board shouting the same thing at somebody who read it
   * the first time. Cleared when the reason changes or the queue drains again, so the next
   * stall — or the same one after a recovery — is announced afresh.
   */
  const announcedStallRef = useRef<string>('')

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
  /**
   * A reconnect that owes the server a write and has not made it yet.
   *
   * Up between `onopen` and the owed sync landing, and read by `initial_elements`: the store
   * has never heard of what was drawn while the socket was down, so a scene taken from it
   * wholesale in that window takes the drawing off the canvas as well — #225, where the
   * evidence of the lost write was destroyed by the reconnect that should have carried it.
   * While this is up an arriving scene is merged into what is here rather than replacing it.
   */
  const owedSyncFlushRef = useRef<boolean>(false)
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

  /** The same, one level down. See `reportSectionClaims`. */
  const subsectionClaimsRef = useRef<string>('')

  const reportSubsectionClaims = (elements: readonly unknown[]): void => {
    const { ignored } = resolveBoardSubsections(elements as unknown as BoardSectionElement[])
    const signature = describeIgnoredSubsectionClaims(ignored)
    if (signature === subsectionClaimsRef.current) return
    subsectionClaimsRef.current = signature
    if (signature) console.warn(`Board subsection ignored: ${signature}`)
  }

  /**
   * Which of the mirror's buttons a selected id belongs to, if it is one of them.
   *
   * Resolved through the container, because a press can land on the glyph rather than on the
   * box: the `+` and the queue toggle both carry a bound text element, and Excalidraw hands
   * back whichever of the two the pointer hit.
   */
  const mirrorButtonOf = (
    scene: readonly { id: string; containerId?: string | null; customData?: CustomData }[],
    id: string
  ): { id: string; role: string; sectionOptionId: string } | null => {
    const clicked = scene.find((candidate) => candidate.id === id)
    const holder = clicked?.containerId
      ? scene.find((candidate) => candidate.id === clicked.containerId) ?? clicked
      : clicked
    const custom = customDataOf(holder)
    if (!holder || custom.kind !== MIRROR_KIND) return null
    if (custom.role !== 'add' && custom.role !== 'queue') return null
    return {
      id: holder.id,
      role: String(custom.role),
      sectionOptionId: String(custom.sectionOptionId ?? '')
    }
  }

  /**
   * Track which selected shape the docs panel should describe.
   *
   * onChange fires on every pointer move, so this bails out unless the selection
   * actually changed — otherwise the panel would refetch continuously while dragging.
   * A multi-selection resolves to no doc: showing one shape's document while several
   * are highlighted reads as if it described all of them.
   */
  const syncSelectedDoc = (appState: {
    selectedElementIds?: Record<string, boolean>
    selectionElement?: unknown
    selectedElementsAreBeingDragged?: boolean
  } | undefined): void => {
    const selectedIds = Object.keys(appState?.selectedElementIds ?? {}).filter(
      (id) => appState?.selectedElementIds?.[id]
    )
    const scene = excalidrawAPI?.getSceneElements() ?? []

    /**
     * A press is one of the mirror's buttons selected on its own, and nothing else.
     *
     * The `+` and the queue toggle are shapes rather than buttons — a locked shape cannot be
     * clicked at all, which is why both are left unlocked — so the press *is* the selection
     * landing on one. Which means a selection can also arrive with company: the header
     * rectangles are locked and no band catches them, but every card, every draft and both
     * buttons are unlocked, so one rubber band across the header strip or one shift-click
     * puts a button in a selection nobody pressed it in. That was answered by resolving the
     * whole selection to `null` and doing nothing at all, which is #244: the button sat there
     * showing an ordinary selection box, looking exactly like a block that had been selected.
     */
    const resolved = selectedIds.map((id) => ({ id, button: mirrorButtonOf(scene, id) }))
    const pressed = resolved.filter((entry) => entry.button)
    const press = resolved.length === 1 && pressed.length === 1 ? pressed[0]?.button ?? null : null
    const rest = resolved.filter((entry) => !entry.button).map((entry) => entry.id)

    // Not while the gesture that made the selection is still running: a band is redrawn on
    // every pointer move and would put the button straight back, so this waits for the
    // release and takes it out of the selection the reader ends up with. Dragging a group is
    // left alone for the same reason — the mirror's own redraw is what puts a button carried
    // off by one back, and that happens on the next refresh either way.
    const settling = Boolean(appState?.selectionElement || appState?.selectedElementsAreBeingDragged)
    const shed = pressed.length > 0 && !press && !settling
    if (shed) {
      excalidrawAPIRef.current?.updateScene({
        appState: { selectedElementIds: Object.fromEntries(rest.map((id) => [id, true])) },
        captureUpdate: CaptureUpdateAction.NEVER
      })
    }

    // What the reader actually selected, which from here on is what the panel describes.
    const effectiveIds = shed ? rest : selectedIds
    const selectedId = effectiveIds.length === 1 ? effectiveIds[0] : null

    if (selectedId === lastSelectedIdRef.current) return
    lastSelectedIdRef.current = selectedId

    // Only a fresh selection counts as a press, which is what the early return above already
    // guarantees — otherwise every pointer move over the button would drop another block.
    if (press) {
      if (press.role === 'add') {
        addIssueBlockToColumn(press.sectionOptionId)
        return
      }
      // The queue toggle is the same kind of button, and the same kind of press.
      void toggleImplementQueue()
      return
    }

    // One answer for the whole panel, including "nothing at all". What this replaced was
    // a missing clear: the branch that handled an emptied selection cleared the document
    // and returned, so an issue block stayed fully open and the card kept an anchor
    // pointing at a shape nobody had selected. Every piece is now written on every pass,
    // so there is no half-cleared state to forget.
    const target = resolvePanelTarget(scene as unknown as PanelElement[], effectiveIds)

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

  /**
   * Put the block under the caret back into a scene about to be written, by object identity.
   *
   * #132 asked this question of the two writers that reflow the notes column, and both
   * answer it themselves. Every other writer went straight through — the socket's
   * `element_updated`, `element_created` and `elements_batch_created`, the `initial_elements`
   * of every reconnect, the 250 ms terminal reconcile, the loader — and each of them hands
   * the whole scene to `convertElementsPreservingImageProps`, which deep-clones the container
   * and rebuilds its label through `newTextElement`. Excalidraw grows a container by mutating
   * it in place and never replaces one whose label is being edited, so a container that is a
   * different object mid-keystroke was replaced by us: the grown height goes with it, and the
   * open editor re-derives the live textarea from whatever landed (#190).
   *
   * So it sits in the funnel every one of them already goes through, rather than at sixteen
   * call sites. It only ever *substitutes*, never adds: an element the write left out stays
   * left out, which is what keeps a deleted shape deleted and a board switch a board switch.
   *
   * The remote update for the edited block itself is dropped rather than deferred, which is
   * the call #190 leaves open. Deferring it would mean replaying, when the caret leaves, a
   * copy of the label captured while somebody was typing into it — overwriting the sentence
   * they just finished with the one the server last heard about. The reader holds the
   * authority for as long as the caret is theirs; the autosync carries what they wrote out
   * the moment it is released. Everything else in the same write still lands immediately, so
   * an `issueState` transition on another block is not held up by somebody typing.
   */
  const keepingTheEditedBlock = (
    api: ExcalidrawImperativeAPI,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): Parameters<ExcalidrawImperativeAPI['updateScene']>[0] => {
    const incoming = (scene as { elements?: readonly ExcalidrawElement[] }).elements
    if (!incoming) return scene
    const frozen = editingDraftId(api)
    if (!frozen) return scene

    const live = new Map<string, ExcalidrawElement>()
    for (const element of api.getSceneElements()) {
      const bound = element as ExcalidrawElement & { containerId?: string | null }
      if (element.id === frozen || bound.containerId === frozen) live.set(element.id, element)
    }
    if (live.size === 0) return scene

    let substituted = false
    const elements = incoming.map((element) => {
      const held = live.get(element.id)
      if (!held || held === element) return element
      substituted = true
      return held
    })
    return substituted ? { ...scene, elements } : scene
  }

  const applySceneUpdateWithoutAutoSync = (
    api: ExcalidrawImperativeAPI,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): void => {
    suppressAutoSyncCountRef.current += 1
    api.updateScene(keepingTheEditedBlock(api, scene))
    setTimeout(() => {
      releaseAutoSyncSuppression()
    }, 0)
  }

  /**
   * Write the fields this page just sent to the server onto its own copy of one element.
   *
   * What the echo used to do, and the reason the echo could be dropped. Two differences, and
   * both are the point: it applies *what was written* rather than the server's whole copy of
   * the element, so nothing arrives a debounce stale; and it does not go through
   * `convertElementsPreservingImageProps`, so no other element on the board is rebuilt for
   * the sake of one field on one of them. These come out of the scene and are already
   * Excalidraw elements — there is nothing for a conversion to do to them.
   *
   * Not synced back: the server has the change already, which is where this came from.
   */
  const patchSceneElement = (elementId: string, patch: Partial<ExcalidrawElement>): void => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const scene = api.getSceneElements()
    if (!scene.some((element) => element.id === elementId)) return
    applySceneUpdateWithoutAutoSync(api, {
      elements: scene.map((element) => (element.id === elementId
        // Excalidraw reconciles by version, so a change whose version stands still is one
        // it may keep as it was.
        ? { ...element, ...patch, version: (element.version ?? 1) + 1 }
        : element)) as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER
    })
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

  /**
   * Where each board was left looking.
   *
   * There is one viewport for the page and there always was: the Excalidraw element carries
   * no React key, so it is never remounted, and a switch swaps the scene underneath it —
   * `scrollX`, `scrollY` and `zoom` carry straight over from the board you left. That is the
   * whole of "moving the view on one tab moves it on the other" (#156): not two views wired
   * together, one view shared. So each board's is written down on the way out and put back
   * on the way in, and a board arrived at for the first time is shown its own content
   * instead of wherever the last board happened to be parked.
   *
   * Seeded from `localStorage` and written back to it since #185, so the same is true of a
   * reload: a zoom chosen by hand is a correction the reader should have to make once.
   */
  const boardViewportsRef = useRef<Map<string, BoardViewport>>(rememberedViewports())

  /** Set once the board's own camera has been put back, so nothing records over it first. */
  const viewportOpenedRef = useRef(false)
  const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const rememberViewport = (workspaceId: string): void => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const state = api.getAppState()
    boardViewportsRef.current.set(workspaceId, {
      scrollX: state.scrollX,
      scrollY: state.scrollY,
      zoom: state.zoom?.value ?? 1
    })
    writeBoardViewports(boardViewportsRef.current)
  }

  /**
   * Where the board on screen is being looked at, noted on every change and written down when
   * it stops moving.
   *
   * `onChange` fires on every step of a pan, so the store is debounced and the map is not:
   * the map is what a tab switch reads, and it has to be right the instant the reader clicks.
   *
   * Nothing is recorded until the opening camera has been restored. The component mounts at
   * `scrollX: 0, scrollY: 0, zoom: 1` and reports it, and a page that wrote *that* down before
   * it had finished reading what was stored would forget the reader's view every reload while
   * looking exactly like it was saving it.
   *
   * `sceneWorkspaceRef`, not `activeWorkspaceRef`: during a switch the shapes on screen still
   * belong to the board being left, and it is that board's camera this is watching.
   */
  const noteViewport = (appState: { scrollX?: number; scrollY?: number; zoom?: { value?: number } }): void => {
    if (!viewportOpenedRef.current) return
    const view = {
      scrollX: appState.scrollX ?? 0,
      scrollY: appState.scrollY ?? 0,
      zoom: appState.zoom?.value ?? 1
    }
    if (!isViewport(view)) return
    boardViewportsRef.current.set(sceneWorkspaceRef.current, view)
    if (viewportSaveTimerRef.current) return
    viewportSaveTimerRef.current = setTimeout(() => {
      viewportSaveTimerRef.current = null
      writeBoardViewports(boardViewportsRef.current)
    }, VIEWPORT_SAVE_MS)
  }

  const applyViewport = (api: ExcalidrawImperativeAPI, view: BoardViewport): void => {
    applySceneUpdateWithoutAutoSync(api, {
      appState: { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom } }
    } as Parameters<ExcalidrawImperativeAPI['updateScene']>[0])
  }

  /**
   * Fit these shapes into the canvas, but never smaller than the board was written.
   *
   * `fitToViewport` alone fits both axes, so a tall narrow board is decided by its height and
   * a wide display buys the reader nothing (#185). `minZoom` is Excalidraw's own floor on that
   * arithmetic; what it is set to is `board-fit.ts`, and the short version is that height may
   * no longer shrink the board below 100% — a board taller than the canvas is scrolled.
   *
   * Scrolled to **where** is #232, and it is the other half of the same argument: a target
   * the floor has left taller than the canvas used to be centred in its own overflow, so the
   * top of it — the mirror's column headers, a section's title — went off the top edge. It is
   * top-aligned now, under whatever Excalidraw's floating menus are covering. `canvasOffsets`
   * carries both, and `boardFitOptions` is the arithmetic.
   *
   * The container is found in the document rather than held on a ref because it is
   * Excalidraw's own box, not one this component renders: `.excalidraw-container` is the
   * class the library puts on it, and it is the same handle the browser checks reach for.
   */
  const fitLegibly = (
    api: ExcalidrawImperativeAPI,
    elements: readonly ExcalidrawElement[],
    animate: boolean
  ): void => {
    const appState = api.getAppState()
    const { minZoom, canvasOffsets } = boardFitOptions(
      elements,
      { width: appState.width, height: appState.height },
      measureBoardChrome(document.querySelector('.excalidraw-container'))
    )
    api.scrollToContent(elements as ExcalidrawElement[], {
      fitToViewport: true,
      animate,
      minZoom,
      canvasOffsets
    })
  }

  /**
   * The middle of the canvas, in scene units — where the reader is looking.
   *
   * Excalidraw's own arithmetic run backwards: a scene point is drawn at
   * `(x + scrollX) * zoom`, so the point drawn at the centre of a canvas `width` across is
   * `width / 2 / zoom - scrollX`. `width` is the canvas rather than the window, which is why
   * `offsetLeft` plays no part: it is the distance to the canvas, and the centre is measured
   * from the canvas.
   */
  const viewportCentre = (api: ExcalidrawImperativeAPI): { x: number; y: number } => {
    const state = api.getAppState()
    const zoom = state.zoom?.value || 1
    return {
      x: state.width / 2 / zoom - state.scrollX,
      y: state.height / 2 / zoom - state.scrollY
    }
  }

  /**
   * What a board that has never been seen is opened on.
   *
   * It used to be *everything on the canvas*, and #245 is the bill for that. A fit takes the
   * width of what it is given, and what it was given is the whole scene: this repository's
   * board is a 1320-wide mirror, a ~1282-wide terminal block and 2324 of documentation, two
   * gaps apart — over 5,000 units against the ~2,544 a maximised 2560 display gives, so the
   * landing was 0.4 and the 13px card body was drawn at 5px. Canvas glyphs have no hinting,
   * so that reads as blurry rather than as small, and there is no resolution to raise:
   * Excalidraw already rasterises every element cache at `devicePixelRatio x zoom`. The zoom
   * was the whole of it, and this was the only path that chose one for the reader.
   *
   * So the board is asked what it is about. A **section** is a board's own statement of that
   * — the same shape `Alt+P` and `Alt+G` reach — and the first one in reading order is where
   * a board switch lands, at the size it was written at rather than at whatever number makes
   * its furniture fit beside it. Below 100% this board is a map, not a document; the region
   * keys are how it is read, and `docs/board-sections.md` says so.
   *
   * A board that declares no section is landed on its **own drawing**: the mirror is rebuilt
   * from GitHub and the terminal block lives as long as its shell, and neither is content the
   * reader switched boards to look at. That is smaller than the whole scene and never larger,
   * so it can only improve the number. Everything, finally, for a board that is nothing but
   * furniture — a fit of no elements is not a landing at all.
   */
  const landingTarget = (
    elements: readonly ExcalidrawElement[]
  ): readonly ExcalidrawElement[] => {
    const section = firstBoardSection(elements as unknown as BoardSectionElement[])
    const drawn = section ? elements.find((element) => element.id === section.id) : undefined
    if (drawn) return [drawn]
    const own = elements.filter((element) => !isDerivedElement(element))
    return own.length > 0 ? own : elements
  }

  /**
   * Put a board back where it was, or show it its own drawing if it has never been seen.
   *
   * `fitToViewport` on that first visit rather than a plain centring: the zoom is inherited
   * too, and a board opened at the zoom another project was read at is the same complaint
   * one step down. Nothing at all when the board is empty — there is no content to fit, and
   * moving to an arbitrary origin would only be a different wrong place.
   */
  const restoreViewport = (workspaceId: string): void => {
    const api = excalidrawAPIRef.current
    if (!api) return
    const seen = boardViewportsRef.current.get(workspaceId)
    if (seen) {
      applyViewport(api, seen)
      return
    }
    const elements = api.getSceneElements()
    if (elements.length === 0) return
    fitLegibly(api, landingTarget(elements as unknown as ExcalidrawElement[]), false)
  }

  /** The new board is on screen (or never will be): let autosync go again. */
  const finishBoardSwitch = (): void => {
    // Read before it is cleared, and only a real switch has one: `loadExistingElements`
    // calls this on an ordinary first load too, where there is no board being landed on and
    // nothing to restore.
    const landed = pendingSceneWorkspaceRef.current
    pendingSceneWorkspaceRef.current = null
    if (landed !== null) {
      sceneWorkspaceRef.current = landed
      restoreViewport(landed)
    }
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
    /**
     * Whether this board's queue is on, and which column it drains.
     *
     * Null while the server has not said — and while it says nothing at all, which is what a
     * board with implementing disabled gets. The toggle is drawn from this and never from the
     * shape: the mirror is rebuilt from GitHub on every poll, so a state kept on the button
     * would last exactly one refresh.
     */
    queue: ImplementQueueState | null
    signature: string
  }>({ board: null, columns: [], errors: {}, implementing: {}, queue: null, signature: '' })

  /** Whether a drag was in flight on the previous change, so its end can be noticed. */
  const mirrorDraggingRef = useRef<boolean>(false)

  /** The draft heights the mirror was last laid out for; a change is what re-slots it. */
  const draftGeometryRef = useRef<string>('')

  /**
   * Where each board's mirror was put, once something measured it, by workspace id.
   *
   * The region used to be re-measured on every poll, which is what let it drift away from
   * the board's own content with nobody touching either (#99). It is decided once now and
   * kept — the terminal's model, and for the terminal's reason: a redraw that re-anchored a
   * region every twenty seconds is a redraw that moves it.
   *
   * **By board, and kept across a switch** — one value, dropped on every switch, was the same
   * bug on a slower cadence (#188): the board came back, the origin was gone, and the region
   * was decided again from whatever the canvas looked like at that moment, which on a board
   * holding only a mirror and a terminal is nothing at all. Keyed by workspace so the next
   * board's content still cannot decide this one's placement, which is what the reset was
   * actually for. A reload is still what re-measures, the way it is for the terminal.
   */
  const mirrorOriginsRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  const clearMirror = (): void => {
    projectBoardRef.current = { board: null, columns: [], errors: {}, implementing: {}, queue: null, signature: '' }
    draftGeometryRef.current = ''
    // This board's, and only this board's: the region is gone from the canvas, so where it
    // was is no longer an answer to keep. Every other board's placement stands.
    mirrorOriginsRef.current.delete(activeWorkspaceRef.current)
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
   * Where the region's top-left corner goes, for a pass that is about to draw it.
   *
   * Anchored to the left of whatever else is on the canvas — measured **once**, and then
   * kept. Recomputing it on every poll is what let the region drift away from the board's
   * own content with nobody touching either (#99); `resolveMirrorOrigin` has the whole of
   * that reasoning, and `mirrorAnchors` says which elements the measurement is allowed to
   * see. Both live beside the layout arithmetic so a check can ask them without a browser.
   *
   * Its own function since #254, because there are now two things that get drawn here: the
   * mirror, and the strip a board draws when its project could not be read at all. Where the
   * second one stands is not a second answer to the same question — it stands where the
   * mirror would have, so that the mirror arriving afterwards replaces it in place. Written
   * twice, the two would have drifted apart the way #188 records every duplicated derivation
   * doing.
   *
   * `width` is what the pass is about to draw, and it is what the remembered answer is
   * measured back from: the pin is the region's **right** edge since #200, so a strip three
   * columns wide and a mirror of four share an edge rather than a corner.
   */
  const placeMirror = (
    scene: readonly ExcalidrawElement[],
    own: readonly ExcalidrawElement[],
    width: number
  ): { x: number; y: number } => {
    // The terminal region, which since #200 is what this region is placed from: the canvas
    // reads mirror | terminals | documentation, so the blocks are the neighbour one step in.
    const terminalRegion = boundsOf(own.filter(isTerminalElement))
    // The region as it is currently drawn, so a shape standing inside it is not mistaken for
    // something the region can be measured against (#188). None on the pass that draws it
    // first, which is right — there is no inside yet to be in.
    const drawn = boundsOf(scene.filter((element) => !element.isDeleted && isMirrorElement(element)))

    // The terminal is left out of the *content* measurement because it is handed in on its
    // own, above: counted twice it would be measured as content as well and drag the answer a
    // block-width further out. A title bound to the block goes with the block — that is the
    // rule the other two doors already state, and `mirrorAnchors` is where all of it is now
    // said once, so a check can ask it without a browser.
    const anchors = mirrorAnchors(own, drawn)

    const bounds = anchors.length > 0
      ? (() => {
        const [minX, minY] = getCommonBounds(anchors as readonly NonDeletedExcalidrawElement[])
        return { minX, minY }
      })()
      : null
    // The blocks are what this region is measured from, one gap left of their left edge. See
    // `resolveMirrorOrigin`; it is one step of the chain the documentation starts rather than
    // a second derivation of the same number, so the two cannot walk apart.
    const workspaceId = activeWorkspaceRef.current
    // A remembered answer that the blocks are now standing in was measured against a board
    // that no longer exists — the region was placed from the content while there was no block
    // to see, and the first one opened lands in the slot it took. Dropped here rather than
    // repaired somewhere else, so the re-measurement is this pass's and there is one place
    // that decides where the region goes. It cannot fire twice: the answer it settles on is a
    // gap clear of the blocks.
    const stranded = Boolean(drawn && terminalRegion
      && drawn.minX < terminalRegion.maxX && terminalRegion.minX < drawn.maxX
      && drawn.minY < terminalRegion.maxY && terminalRegion.minY < drawn.maxY)
    if (stranded) mirrorOriginsRef.current.delete(workspaceId)
    const { origin, settled } = resolveMirrorOrigin(
      stranded ? null : mirrorOriginsRef.current.get(workspaceId), bounds, width, terminalRegion
    )
    // Only a measured origin is remembered, and it is remembered by the edge it pins — the
    // right one since #200, so a column added on GitHub grows the region into the empty
    // canvas beyond it rather than onto the blocks. A poll that ran before the scene arrived
    // pins nothing, or the region would stay where an empty canvas put it for the session.
    if (settled) mirrorOriginsRef.current.set(workspaceId, { right: origin.x + width, y: origin.y })
    return origin
  }

  /**
   * Say on the canvas that the project could not be read, when there is nothing drawn yet.
   *
   * The gap #254 names: `refreshProjectBoard` returned on every failure that was not a 404,
   * which is right on a board whose mirror is already up — a blip must not wipe a region
   * somebody is reading — and is silence on a **cold** one, where nothing has ever been drawn
   * and nothing is therefore what stays on the screen. From the canvas that is
   * indistinguishable from a board with no `githubProject` at all, and #252 is what it cost.
   *
   * Warm is `board` being set rather than a shape being present, because that is the question
   * being asked: is there a region here that was read from GitHub and is worth keeping? The
   * strip itself is a mirror element, so a scene-side test would call the board warm the
   * moment the strip landed and never correct the words on it again.
   *
   * `layoutUnreadable` says what it draws and why it is a strip rather than a toast.
   */
  const renderUnreadable = (reason: string): void => {
    const api = excalidrawAPIRef.current
    if (!api) return
    if (projectBoardRef.current.board) return
    // Same reason as every other write to this region: a redraw under a pointer or a caret
    // takes the thing being worked on out from under it.
    if (busyOnCanvas(api)) return

    const scene = api.getSceneElementsIncludingDeleted()
    const tombstones = scene.filter((element) => element.isDeleted && !isMirrorElement(element))
    const own = scene.filter((element) => !element.isDeleted && !isMirrorElement(element))

    const elements = layoutUnreadable(reason, placeMirror(scene, own, UNREADABLE_WIDTH))

    // The poll comes round every twenty seconds and the failure is usually the same one, so
    // the second pass has nothing to write. Sharing `signature` with the mirror is what makes
    // the board arriving afterwards redraw: its signature is built from a whole layout and
    // cannot equal this one.
    const signature = JSON.stringify(elements)
    if (signature === projectBoardRef.current.signature
        && scene.some((element) => isMirrorElement(element))) {
      return
    }
    projectBoardRef.current = { ...projectBoardRef.current, signature }

    applySceneUpdateWithoutAutoSync(api, {
      elements: [
        ...convertElementsPreservingImageProps([
          ...(own as unknown as Partial<ExcalidrawElement>[]),
          ...(elements as unknown as Partial<ExcalidrawElement>[])
        ]),
        ...tombstones
      ] as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER
    })

    // Excalidraw measures bound text when the element lands and keeps that number, so a label
    // that arrives before the handwriting font does is stored narrow and then drawn with the
    // real font and clipped to the stored width — a character or two off each end. That is a
    // standing trap on this board, and what makes it self-correcting for the mirror is the
    // poll: the board changes, the region is drawn again, the text is measured again. This
    // strip has the opposite property. The failure it reports is usually the *same* failure
    // every twenty seconds, so the signature above skips every redraw and the clipped
    // measurement is the one that stays — measured in a browser at 467 against a sentence the
    // page makes 510 wide.
    //
    // So the first pass after the fonts arrive draws it once more. It cannot loop: by then
    // `status` is `loaded`. The signature has to be dropped or that redraw is the one thing
    // this function is built to skip, and a board that came back meanwhile keeps its own.
    if (document.fonts && document.fonts.status !== 'loaded') {
      void document.fonts.ready.then(() => {
        if (projectBoardRef.current.board) return
        projectBoardRef.current = { ...projectBoardRef.current, signature: '' }
        renderUnreadable(reason)
      })
    }
  }

  /**
   * Draw the mirror for a board that was just read.
   *
   * Where it goes is `placeMirror`'s answer, measured once against the board's own content
   * and then kept.
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

    // The notes column is drawn too, and it is as wide as the rest, so the width the first
    // measurement places the region by has to include it — `mirrorWidth`, not `boardWidth`,
    // which counts only the options the project declares.
    const width = mirrorWidth(board)
    const origin = placeMirror(scene, own, width)

    // The blocks the `+` dropped hold the top of their column, newest first, and the
    // mirrored cards start below them. Both halves of that arithmetic come from
    // `layoutMirror`, so the room reserved and the slot a block is put in cannot disagree
    // — and it is what draws the notes column those blocks live in, which the project
    // itself declares nothing for.
    // Which column carries the queue toggle is resolved here, from the name the server sends
    // back with the state: the server knows the workspace's `projectTodoColumn`, and the
    // section ids are GitHub's and change with the project. Matched the way every other
    // column lookup in this project is — trimmed and case-insensitively.
    const queue = projectBoardRef.current.queue
    const queueColumn = queue
      ? board.sections.find(
        (section) => section.name.trim().toLowerCase() === queue.column.trim().toLowerCase()
      )
      : undefined

    const layout = layoutMirror(board, origin, {
      errors: projectBoardRef.current.errors,
      implementing: projectBoardRef.current.implementing,
      drafts: drafts.map(draftBlockOf),
      ...(queue && queueColumn
        ? {
          queue: {
            sectionOptionId: queueColumn.optionId,
            enabled: queue.enabled,
            stalled: queue.stalled
          }
        }
        : {})
    })
    const placed = new Map(layout.drafts.map((placement) => [placement.id, placement]))

    // The block being typed into is left exactly where it is: rewriting a container and
    // its label out from under a caret is how an editor gets closed, or worse, corrupted.
    // Only that one, though — everything else in the column still makes room for it, and
    // the block itself does not need to move anyway, being already at the top and only
    // growing. It is re-slotted when the editor closes, which `frozen` in the signature is
    // what makes happen.
    const frozen = editingDraftId(api)

    // Nothing here moves a block any more. It used to: while the block was placed from the
    // mirror, one opened before the first board landed had guessed at the mirror's slot and
    // had to be moved out of it once the region arrived (#124's `awaitingMirror`). Since #200
    // the block is placed from the documentation, which is on the canvas before any poll, so
    // there is no guess to correct — and it is the *region* that gives way when the two meet,
    // which `stranded` above does by re-measuring rather than by moving anything of the
    // reader's.
    const nextOwn = own.map((element) => {
      if (isTerminalElement(element)) return element
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

    // The block under the caret is never moved by this pass — `frozen` above sees to that —
    // so its own height is not a reason to write the scene again. Left in, it was: a
    // container grows to fit its label, so every keystroke changed the number and every
    // keystroke rewrote a scene in which nothing had actually moved. Each of those updates
    // restyles and refocuses the open label editor, which is the flicker #132 reports. What
    // the blocks *below* it are placed at is still in the signature, and still moves them.
    const written = frozen
      ? layout.drafts.map((placement) =>
        (placement.id === frozen ? { ...placement, height: 0 } : placement))
      : layout.drafts

    /**
     * A button the reader has moved, or removed, is a reason to draw the mirror again.
     *
     * The `+` and the queue toggle are the only two mirror shapes left unlocked — a locked
     * shape cannot be pressed, and both are buttons — so they are the only two a drag or a
     * `Delete` can take away from where the layout put them. `project-board-layout.ts` says a
     * stray drag "is corrected by the next refresh", and it was not: the signature below is
     * built from what the layout *wants*, so it matches unchanged on a board whose `+` is
     * sitting in the middle of the canvas, and the only scene-side question asked was whether
     * a mirror had been drawn at all. Nudged out of its header on an otherwise unchanging
     * board, the `+` stayed out — a loose rectangle, which is the other half of what #244
     * reports as "selecting as a block".
     *
     * Positions only, and only these two: everything else the mirror draws is locked and can
     * therefore only be where the last redraw put it, so asking about it would cost a
     * comparison per element per poll to learn nothing.
     */
    const strayButton = layout.elements.some((wanted) => {
      const role = customDataOf(wanted).role
      if (role !== 'add' && role !== 'queue') return false
      const drawnHere = scene.find((element) => element.id === wanted.id && !element.isDeleted)
      return !drawnHere
        || Math.abs(drawnHere.x - wanted.x) > 0.5 || Math.abs(drawnHere.y - wanted.y) > 0.5
    })

    // `frozen` is part of the signature because it changes what gets written: the pass that
    // left a block alone must not let the one after the editor closed, which puts it back
    // in its slot, be skipped as "nothing moved".
    const signature = JSON.stringify([layout.elements, written, frozen])
    if (signature === projectBoardRef.current.signature
        && scene.some((element) => isMirrorElement(element))
        && !strayButton) {
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

    // The block under the caret comes through verbatim, and that is the other half of the
    // guard `frozen` starts. Leaving it in its slot is not enough on its own, because it is
    // still in the array handed to `convertElementsPreservingImageProps`, and that runs
    // everything through `convertToExcalidrawElements`: the container is deep-cloned and the
    // label bound to it is rebuilt through `newTextElement`, re-measured and shifted by the
    // alignment offsets. Excalidraw grows a container by mutating it in place and never
    // hands back a new object for one whose label is being edited — so a replacement here is
    // ours, arriving per keystroke, and the open editor re-derives the live textarea from
    // whatever it lands on (#132). These come out of the scene and are already Excalidraw
    // elements, so there is nothing for the conversion to do to them anyway.
    const untouched = new Map(
      frozen
        ? own
          .filter((element) => element.id === frozen || element.containerId === frozen)
          .map((element) => [element.id, element] as const)
        : []
    )
    const converted = convertElementsPreservingImageProps([
      ...(nextOwn as unknown as Partial<ExcalidrawElement>[]),
      ...(layout.elements as unknown as Partial<ExcalidrawElement>[])
    ]).map((element) => (untouched.get(String(element.id)) as unknown as Partial<ExcalidrawElement>) ?? element)

    applySceneUpdateWithoutAutoSync(api, {
      elements: [
        ...converted,
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

    // This is the one whole-scene write on the board that had no editor guard at all, and it
    // is issued after its own awaits, so the caller's guard is by then several requests old
    // (#132). The blocks are already gone from the server, so nothing is lost by leaving the
    // scene alone: the next poll finds the same blocks still matching the same cards and
    // reaches this line again, with the caret gone.
    if (busyOnCanvas(api)) return

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
  const readImplementRecords = async (): Promise<{
    implementing: Record<string, CardImplementState>
    queue: ImplementQueueState | null
  }> => {
    try {
      const response = await fetch(apiUrl('/api/implement'))
      if (!response.ok) return { implementing: {}, queue: null }
      const body = await response.json().catch(() => ({}))
      const runs = Array.isArray(body?.runs) ? body.runs : []
      // Absent rather than off is the server saying implementing is not available here at
      // all, and the toggle is then not drawn — the same answer a board gets before the first
      // read comes back.
      const queue = body?.queue && typeof body.queue.enabled === 'boolean'
        ? {
          enabled: body.queue.enabled === true,
          column: String(body.queue.column ?? ''),
          stalled: body.queue.stalled === true,
          reason: String(body.queue.lastPass?.detail ?? '')
        }
        : null
      return {
        implementing: Object.fromEntries(
          runs
            .filter((run: { issueUrl?: string; state?: string }) => Boolean(run?.issueUrl && run.state))
            .map((run: { issueUrl: string; state: CardImplementState }) => [run.issueUrl, run.state])
        ),
        queue
      }
    } catch {
      // A board that draws no run marks is worse than one that draws them; a board that
      // stops redrawing because this request failed is worse than both.
      return { implementing: {}, queue: null }
    }
  }

  /**
   * Say, once, that the queue is on and getting nowhere.
   *
   * The toggle's broken outline is what a reader sees at a glance and it cannot carry the
   * reason — which is the half that matters, because every stall has a different thing to do
   * about it: four slots held by runs that will never end, a column renamed on GitHub, a `gh`
   * that has stopped answering. The server composes the sentence; this decides when it is
   * worth interrupting for, which is when it changes.
   */
  const announceQueueStall = (
    api: ExcalidrawImperativeAPI,
    queue: ImplementQueueState | null
  ): void => {
    if (!queue?.enabled || !queue.stalled || !queue.reason) {
      announcedStallRef.current = ''
      return
    }
    if (announcedStallRef.current === queue.reason) return
    announcedStallRef.current = queue.reason
    sayOnCanvas(api, `The implementation queue is on and starting nothing. ${queue.reason}`)
  }

  /**
   * Flip this board's queue, and redraw the button from what the server answers.
   *
   * From the answer and not from what was clicked: the state lives on the server, one per
   * workspace, and a button drawn from an optimistic guess would show a queue that is on
   * while the request that was meant to turn it on was refused. `signature` is cleared so
   * the redraw is not skipped as "nothing moved" — the mirror is otherwise identical, and
   * the toggle's fill is the only thing that changed.
   *
   * The selection is dropped afterwards, which is load bearing rather than tidy: this button
   * is *selected* rather than clicked, and `syncSelectedDoc` bails out when the selection has
   * not changed. Leaving it selected would make the second click — the one that turns the
   * queue off again — do nothing at all.
   */
  const toggleImplementQueue = async (): Promise<void> => {
    const api = excalidrawAPIRef.current
    const current = projectBoardRef.current.queue
    if (!api || !current) return

    api.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER })
    lastSelectedIdRef.current = null

    try {
      const response = await fetch(apiUrl('/api/implement/queue'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !current.enabled })
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body?.success || typeof body?.queue?.enabled !== 'boolean') {
        console.warn('Could not switch the implementation queue:', body?.error ?? response.status)
        return
      }
      projectBoardRef.current = {
        ...projectBoardRef.current,
        queue: {
          enabled: body.queue.enabled === true,
          column: String(body.queue.column ?? ''),
          stalled: body.queue.stalled === true,
          reason: String(body.queue.lastPass?.detail ?? '')
        },
        signature: ''
      }
      // A queue just switched has no pass behind it yet, so nothing said before the click
      // describes what it is doing now.
      announcedStallRef.current = ''
      const board = projectBoardRef.current.board
      if (board) renderMirror(board)
    } catch (error) {
      console.warn('Could not switch the implementation queue:', error)
    }
  }

  /** Re-read the project and redraw. A board with no project configured stays blank. */
  const refreshProjectBoard = async (): Promise<void> => {
    const api = excalidrawAPIRef.current
    if (!api) return

    // Never redraw under a pointer or a caret: rebuilding while a card is being dragged
    // or a label typed into would take the thing being worked on out from under it.
    if (busyOnCanvas(api)) return

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
      if (!body?.success || !body.board) {
        // Not a 404 — that was answered above and means the board simply has no project.
        // This is `gh` unresolvable, an expired login, a token without the `project` scope,
        // a GitHub outage, or the loopback refusal, and every one of them arrives here with
        // its own sentence in `body.error`. Throwing that away is what #254 is about.
        console.warn('Could not read the project board:', body?.error ?? response.status)
        renderUnreadable(String(body?.error ?? `The server answered ${response.status}.`))
        return
      }
      await reconcileDrafts(body.board as ProjectBoard)
      if (activeWorkspaceRef.current !== workspace) return
      const { implementing, queue } = await readImplementRecords()
      if (activeWorkspaceRef.current !== workspace) return
      projectBoardRef.current = { ...projectBoardRef.current, implementing, queue }
      announceQueueStall(api, queue)
      // Asked again, because the guard at the top of this function was read before a `gh`
      // call and two more requests. The reader who started typing inside those seconds is
      // the reader this poll would otherwise redraw over — the twenty-second version of the
      // disturbance #132 reports. The board and the run records are kept either way; only
      // the scene is left alone, and the next poll draws it.
      if (busyOnCanvas(api)) return
      renderMirror(body.board as ProjectBoard)
    } catch (error) {
      // The request never got an answer — the server down, or the page offline. Silent for
      // the same reason and with the same cost as the branch above, so it says the same
      // thing; a warm mirror is still left exactly where it is.
      console.warn('Could not read the project board:', error)
      if (activeWorkspaceRef.current !== workspace) return
      renderUnreadable((error as Error).message)
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
    if (!api) return

    // Answered before anything that could go wrong does, which is load bearing rather than
    // tidy — the same reasoning `toggleImplementQueue` states, and for the same reason. This
    // button is *selected* rather than clicked, and `syncSelectedDoc` bails out when the
    // selection has not changed, so a path that returned with the `+` still selected left it
    // both looking like an ordinary selected block and unable to be pressed again: the second
    // press is the same selection arriving twice, and is dropped. Every return below was such
    // a path, and #244 is what they add up to.
    api.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER })
    lastSelectedIdRef.current = null

    if (!board) return

    // Nothing on the canvas for this: no column means no mirror was drawn, and the `+` is
    // drawn by the mirror, so there is no button here to have been pressed.
    const column = columns.find((candidate) => candidate.optionId === sectionOptionId) ?? columns[0]
    if (!column) {
      console.warn('The mirror has no column to drop a block into.')
      return
    }

    const template = findIssueBlockTemplate(libraryItems)
    if (!template) {
      sayOnCanvas(api, 'The library ships no issue block, so + has nothing to drop.')
      return
    }

    // At most one block nobody has written into. The `+` is a shape rather than a button,
    // so the click on it is the selection landing on it, and the handler hands the
    // selection straight back to the block it made — which re-arms the shape for the very
    // next press. A double click, or an impatient second press while the first block is
    // still being drawn behind the redraw, therefore used to make two empty blocks, and
    // five presses made five. Each one has to be deleted by hand.
    //
    // The one already waiting is handed back instead, selected so it is obvious which block
    // the press was answered with. Only *unpopulated* blocks are capped: an observation
    // that has been typed into is somebody's, and so is a block a run has turned into an
    // issue, so the `+` still owes the reader a fresh one in both cases.
    //
    // Every draft on the canvas is considered, not only the ones stamped with this column.
    // The stamp is vestigial (#117) — the layout draws every draft in the notes column
    // whatever it says — so "one empty block in this column" and "one empty block" are the
    // same rule, and reading the stamp would let a block stranded by an old ordering hide
    // from it.
    const scene = api.getSceneElements() as unknown as LabelledElement[]
    const placeholder = draftPlaceholder(template)
    const waiting = placeholder === null ? undefined : scene.find(
      (element) => !element.isDeleted && isDraftBlock(element)
        && isUnpopulatedDraft(element, scene, placeholder)
    )
    if (waiting) {
      api.updateScene({
        appState: { selectedElementIds: { [waiting.id]: true } },
        captureUpdate: CaptureUpdateAction.EVENTUALLY
      })
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
    if (created.length === 0) {
      sayOnCanvas(api, 'The library ships an issue block that could not be built, so + dropped nothing.')
      return
    }

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
    /**
     * Why the mode is `pipe`, where that is a fallback rather than a decision, or null.
     *
     * The mode alone told a reader that their board behaves unlike the one in the
     * documentation and not what to do about it: the cause — a missing prebuilt binding,
     * named by the import error, or `EXCALIDRAW_TERMINAL_PTY=0` — was a line in a log file.
     */
    pipeReason?: string | null
    cols: number
    rows: number
    /**
     * Whose session this is, when the server opened it for one of its own agents.
     *
     * Null for every shell a reader opened, which is what leaves those tabs exactly as they
     * were. A run's tab arrives without anyone asking, so the strip labels it with the issue
     * rather than with the next number in the sequence.
     */
    owner: { agent: string; issueUrl: string; label: string } | null
    /**
     * Whether there is anything for a keystroke to reach.
     *
     * True only for an agent's session whose stdin was spent on its prompt. The block asks
     * before it sends: a route that answered 202 for bytes it dropped, and a screen that
     * took them without saying, agreed with each other about a message nobody received.
     */
    readOnly?: boolean
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
        pipeReason: session.pipeReason ?? null,
        cols: session.cols,
        rows: session.rows,
        owner: session.owner ?? null
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

  /**
   * A session id, qualified by the board whose scene it is drawn on.
   *
   * `nextTerminalId` counts from 1 per board, so the first shell of *every* board is called
   * `s1` and the second `s2`. Anything the browser caches per session therefore has to say
   * which board's session it means, or the two boards share one entry — which is how the
   * geometry of one project's terminal came to place another project's block (#156).
   *
   * `sceneWorkspaceRef`, not `activeWorkspaceRef`: these are all read and written from what
   * is drawn on the canvas, and during a switch the canvas is still showing the board being
   * left while the active id already names the one being entered.
   */
  const terminalKeyOf = (sessionId: string): string => `${sceneWorkspaceRef.current}::${sessionId}`

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
   *
   * By `terminalKeyOf`, so the session is the one on the board it was drawn on. It survives
   * a board switch on purpose: where a reader put a project's terminal is that project's,
   * and going away to another tab and coming back is not a reason to lose it.
   */
  const terminalHomesRef = useRef<Map<string, { x: number; y: number; width: number; height: number }>>(new Map())

  /** The rect last written to `localStorage`, so a pan does not rewrite the same one. */
  const terminalStoredGeometryRef = useRef<string>('')

  /**
   * How far right each board's documentation currently stands from where it was authored.
   *
   * Page state over the stored number, and keyed by board for the reason everything else
   * about a terminal is: a board switched away from and back has not moved its content, and
   * a shift dropped on the way out would be a push applied twice on the way back in.
   */
  const documentationShiftRef = useRef<Map<string, number>>(new Map())

  const documentationShiftOf = (workspace: string): number => {
    const held = documentationShiftRef.current.get(workspace)
    if (held !== undefined) return held
    const stored = readDocumentationShift(workspace)
    documentationShiftRef.current.set(workspace, stored)
    return stored
  }

  /** Remember this board's block rect across the doors the refs above do not survive. */
  const rememberTerminalGeometry = (rect: TerminalRect): void => {
    const workspace = activeWorkspaceRef.current
    const signature = `${workspace}|${rect.x},${rect.y},${rect.width},${rect.height}`
    if (terminalStoredGeometryRef.current === signature) return
    terminalStoredGeometryRef.current = signature
    writeTerminalGeometry(workspace, rect)
  }

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
    added: Record<string, unknown>[] = [],
    /**
     * Whether this commit may move the documentation.
     *
     * Off by default, and that default is the decision. Every arrangement of the blocks
     * comes through here, and most of them are not the tool deciding how much room the
     * region takes: a board switched to puts its blocks back at the rects the reader left
     * them at, an erased block is restored at its own, a tab is switched. Content that
     * stepped aside for any of those would be the board rearranging itself whenever anybody
     * looked at it, and a block the reader has dragged is theirs — the canvas does not run
     * away from it.
     *
     * The two gestures the observation on #200 names are the two that turn it fully on: `⧉`
     * splits, which grows the region by a block, and `⇤` merges, which gives that block
     * back. Both are the tool choosing the geometry, and they are exactly the pair the round
     * trip is between.
     *
     * `'shrink'` is the third answer, and it is #255. A shell that exits — the `×` on a
     * detached block's last tab, or a program ending on its own — also drops a block, and it
     * came through here with this off: the region shrank and the push stayed, leaving one
     * block with a slot exactly one block and both gaps wide between it and the content. It
     * cannot simply be `true`, because this path runs on every reconcile and `natural` is
     * derived from where the content currently stands, so a reader dragging their block
     * rightward would have the board run away from them. So it settles **downwards only**,
     * and only on a pass where the tool itself dropped a block: the region can never ask for
     * more room on this path, and a pass that added or merely rearranged blocks changes
     * nothing. What that buys is the strand the round trip was missing — `⧉` then `×` ends
     * where `⧉` then `⇤` ends.
     */
    settle: boolean | 'shrink' = false
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

    /**
     * The documentation steps aside for the region, and comes back when the region gives
     * the room up. This is #200's other half, and the half with no precedent: nothing in
     * this project had moved authored content before.
     *
     * It is here, in the one funnel every arrangement of the blocks already comes through,
     * because every gesture that changes how much room the region takes is one of these —
     * a detach adds a block one block-width and 40 further right, `⇤` drops one, a shell
     * that exits drops one, a restore puts one back. Written as "where the documentation
     * belongs given the region as it now stands" rather than as a nudge per gesture: the
     * absolute answer is what makes the round trip exact, and the second observation on
     * #200 asked for exactly that — a merge has to put the board back where it was, not
     * near it, or opening and closing shells walks the board right by the rounding.
     *
     * `natural` is where the board authored the documentation, which is where it is now
     * less however far this has already pushed it. It has to be remembered rather than
     * looked at: a pushed board and a board at rest are the same picture, because in both
     * the leftmost block sits exactly one gap left of the content.
     */
    const workspace = activeWorkspaceRef.current
    const applied = documentationShiftOf(workspace)
    const blocks = [...next, ...added] as unknown as ExcalidrawElement[]
    const region = boxOf(blocks.filter((element) => isTerminalElement(element)))
    const documentation = documentationElements(next as unknown as ExcalidrawElement[])
    const standing = settle ? boxOf(documentation) : null
    const exact = standing ? documentationClearance(region, standing.minX - applied) : applied
    // Downwards only on the reconcile path, and only where this pass dropped a block. Both
    // halves are load-bearing: `Math.min` is what keeps a dragged block from pushing the
    // board, and `dropped` is what keeps a board switched to — where the scene arrives with
    // no blocks at all and they are added back — from reading an empty region as "no room
    // needed" and pulling that board's content left. See the note on `settle`.
    const wanted = settle === 'shrink'
      ? (dropped.size > 0 ? Math.min(applied, exact) : applied)
      : exact
    const shift = wanted - applied
    const moving = new Set(shift === 0 ? [] : documentation.map((element) => element.id))
    const placed = moving.size === 0 ? next : next.map((element) => (
      moving.has(element.id)
        // Excalidraw reconciles by version and so does the store: a shape that moved with
        // its version standing still is one both of them may keep where it was.
        ? { ...element, x: element.x + shift, version: (element.version ?? 1) + 1 }
        : element
    ))
    if (shift !== 0) {
      documentationShiftRef.current.set(workspace, wanted)
      writeDocumentationShift(workspace, wanted)
    }

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
          [...placed, ...added] as unknown as Partial<ExcalidrawElement>[]
        ),
        ...tombstones
      ] as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER
    })

    // A moved documentation is authored data, so the store is told about it now rather than
    // whenever the reader next touches the board. Not an optimisation and not tidiness: the
    // shift above is remembered as a number, and a number that says "pushed" over a store
    // that still holds the board at rest is what a reload would read back and push again.
    // The two have to be one answer. Held off only across a board switch, which is the one
    // window where the scene on screen and the board this would write to are not the same
    // board — the arrangement is re-settled on the way in anyway.
    if (shift !== 0 && !autoSyncHoldRef.current) void flushAutoSync()
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
   * block goes to the **right** of the one the tab came out of, the way the region grows.
   * `at` is a **restore**: the block was
   * erased and putting it back means putting it *back*, at the size and position the reader
   * had it, because a restore that re-anchored it would answer an accidental erase by also
   * undoing a drag. Neither is where a terminal *goes*, which is the last case: one gap left
   * of the documentation, whether or not the board draws a mirror further out.
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

    const beside = where.beside
    if (beside) {
      return terminalBlockElement(
        // Right of the block it came out of, and always right: since #200 the region grows
        // that way. It went left until then, because #96 had put the block on the far left
        // precisely so it would not stand where the board grows — a detach that went right
        // would have authored a block back into the direction that move emptied, and from the
        // anchored origin one gap left of the mirror the very first one landed on top of the
        // mirror. The order reversed, and with it both halves of that: the mirror is now
        // further out, and the documentation this grows into is moved aside by
        // `settleDocumentation` rather than drawn over. Unconditional rather than whichever
        // side happens to be free, so the reader can predict where it appears (#124). Where it
        // goes from there is their business — it is an ordinary shape and the canvas moves it.
        { x: beside.x + beside.width + 40, y: beside.y },
        { width: beside.width, height: beside.height },
        { sessions, active: sessions[0] ?? '' }
      )
    }
    if (where.at) {
      return terminalBlockElement(
        { x: where.at.x, y: where.at.y },
        { width: where.at.width, height: where.at.height },
        { sessions, active: sessions[0] ?? '' }
      )
    }

    // Where this board's block was last left, if it has ever been left anywhere (#154).
    //
    // A floor under the two refs above rather than a replacement for them: they are page
    // state, and a reload is the door out of a page that drops them. A switch of board and
    // back used to be a second such door, because the refs were cleared by hand on the way
    // into a board; since #156 they are keyed by board and survive it. A session that came
    // back at the default was not only a shape moving. The block reports
    // its own grid, the server puts it at the live shell, and a full-screen program repaints
    // into a smaller screen than the reader left it at.
    //
    // The size and the position together, because they are one rect and one gesture:
    // restoring the size into the anchor's slot would put a block the reader had dragged
    // aside back in front of the content, at its own size.
    //
    // A rect remembered from before #200 turned the canvas round is left exactly as it is,
    // rather than migrated. It is a position the reader chose, and re-anchoring it is how a
    // reload comes to undo a drag — the reason `at` gives about a restore. Where it lands is
    // no longer a collision anybody has to live with either: the mirror re-measures around a
    // block standing in it, and the documentation steps aside from one standing in *it*.
    const remembered = readTerminalGeometry(activeWorkspaceRef.current)
    if (remembered) {
      return terminalBlockElement(
        { x: remembered.x, y: remembered.y },
        { width: remembered.width, height: remembered.height },
        { sessions, active: sessions[0] ?? '' }
      )
    }

    // What this board authored, which is neither the mirror nor a terminal block — the
    // documentation, and since #200 the only region the block is placed from. There is no
    // "no mirror drawn yet" case left to guess at: the content is on the canvas before the
    // poll that spawns a `gh` has come back, so the answer is the same either way.
    const bounds = boundsOf(scene.filter((element) => !isDerivedElement(element)))

    // The one placement that chooses a size, and since #199 it chooses a **grid** and lets
    // the size fall out of it: `TERMINAL_GRID` cells against the cell this browser measured.
    // A rectangle cannot pin a grid — the fallback stack advances five per cent wider than
    // Comic Shanns, which is seven columns of a default block — so a constant here would be
    // 125 columns on one machine and 132 on another.
    //
    // At the font the reader is on rather than at the default, so "a fresh terminal is
    // 125 × 30" stays true after they have pressed `+`: the promise is about the screen, and
    // a block sized for 18px text would hand a reader at 24 a little over ninety columns.
    //
    // Passed to `terminalOrigin` as well as to the element. The origin is measured from the
    // block's right edge — one gap left of the documentation — so a derived size given to one
    // and not the other is a block that hangs into the content by however much the two differ.
    const font = terminalFontRef.current
    const size = terminalSizeFor(TERMINAL_GRID, font, terminalLineBox(font), terminalAdvance(font))

    return terminalBlockElement(terminalOrigin(bounds, size), size, {
      sessions,
      active: sessions[0] ?? ''
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
      const home = terminalHomesRef.current.get(terminalKeyOf(sessionId))
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
        terminalHomesRef.current.delete(terminalKeyOf(sessionId))
        terminalGridRef.current.delete(terminalKeyOf(sessionId))
      }
    }

    // `'shrink'` rather than nothing, since #255: this is the door a shell that exits comes
    // through, and a block dropped here shrinks the region exactly as `⇤` does. It cannot be
    // the full settle `⇤` gets — this also runs on a poll, on a socket message and on a scene
    // replaced, none of which are a decision about the geometry — so it may only give room
    // back, never ask for more.
    commitTerminalLayout(layout, added, 'shrink')

    // The mirror is placed from this region, so a block appearing where there was none is a
    // measurement that region has not been given yet. `resolveMirrorOrigin` answers an empty
    // anchor set with a content-independent fallback and deliberately does not remember it —
    // so it re-decides on every pass, and left alone the next pass is the twenty-second poll.
    // That is the drift #188 is about, seen from the other side, and #199 turned it from a
    // race into the usual case: waiting for the terminal's face before deriving the first
    // block's size puts the block *after* the mirror's first draw rather than before it.
    //
    // Only when a block was actually added, and harmless when the region was already settled:
    // a remembered origin is pinned by its right edge and this pass re-reads the same one.
    if (added.length > 0) {
      const board = projectBoardRef.current.board
      if (board) {
        projectBoardRef.current = { ...projectBoardRef.current, signature: '' }
        renderMirror(board)
      }
    }

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
      // Started beside the request rather than before it, and waited for after: this is the
      // door the *first* block of a page comes through, and since #199 that block is sized
      // from the cell the browser measures. Excalidraw registers the code face without
      // loading it — `terminalFontReady` is the whole note on that — so a block placed a beat
      // early measures the fallback stack and lands 132 columns wide where 125 was asked for.
      // Nothing else waits on this: the grid a block *reports* is re-measured whenever it is
      // reported, and there is already a mount effect that reports it again once the face
      // lands. It is the rectangle, placed once and then left alone, that cannot be revised.
      const face = terminalFontReady()
      const response = await fetch(apiUrl('/api/terminal'))
      if (!response.ok) return
      const body = await response.json().catch(() => ({}))
      await face

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
    terminalGridRef.current.delete(terminalKeyOf(sessionId))
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
    commitTerminalLayout(layout, [newTerminalBlock(api, [sessionId], { beside: source })], true)
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
    commitTerminalLayout(layout, [], true)
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
   * Has the board claimed this chord? Asked by the terminal overlay, which sees the key first.
   *
   * It has to be asked *there* rather than answered here, and that is the shape of #177 rather
   * than a preference: xterm listens on its own helper textarea and the four board listeners
   * are on `window`, so by the time one of them could say "this one is mine" the emulator has
   * already written the meta escape to the shell and the card has already stopped the event
   * propagating. The overlay needs the answer before it decides, so the question comes to the
   * board instead of the answer going out to the block.
   *
   * Resolved on the press, for the reason the section listener resolves there: a section is a
   * shape like any other, so it can be drawn, retitled or deleted while the page is open.
   *
   * The two constants are the board's whether or not there is anything to jump to — `Alt+B` on
   * a board with no mirror does nothing, and it does nothing *rather than* reaching the shell.
   * A key whose owner depended on what happened to be drawn would be a key the reader could
   * not learn.
   */
  const isBoardHotkey = (event: KeyboardEvent): boolean => {
    if (!isBoardHotkeyChord(event)) return false
    if (event.code === MIRROR_HOTKEY_CODE || event.code === TERMINAL_HOTKEY_CODE) return true
    const api = excalidrawAPIRef.current
    if (!api) return false
    const elements = api.getSceneElements() as unknown as BoardSectionElement[]
    // The arrows on the same footing as a section's key, and for the same reason: they are
    // the board's only while the board has drawn something to step between. A shell keeps
    // Alt+Left and Alt+Right on every board that draws no parts.
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
      return resolveBoardSubsections(elements).groups.some((group) => group.subsections.length > 0)
    }
    return resolveBoardSectionHotkeys(elements).bindings.some((binding) => binding.code === event.code)
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

    /**
     * A board switch is in flight, so these shapes are not this board's.
     *
     * The board being left stays on screen until the new one lands — deliberately, because a
     * canvas that goes blank for the length of a reconnect reads as data loss — so there is a
     * window where `activeWorkspaceRef` already names one board and the scene still draws
     * another. `holdAutoSyncForSwitch` defends the store from exactly this window; what has
     * to be defended here is anything keyed by something that repeats across boards.
     *
     * Session ids are numbered per board, so *both* boards' first shell is `s1`, and a home
     * recorded from the board you left is read straight back out for the board you went to —
     * which is a fresh terminal opening at another project's rect. The rect below is worse
     * still, being the memory that outlives the page.
     */
    const switching = pendingSceneWorkspaceRef.current !== null

    const views: TerminalView[] = []
    /** The first block's rect, which is the one a board comes back to. See below. */
    let leading: TerminalRect | null = null
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
      // Written mid-switch as well as outside one, because the key now says which board's
      // `s1` this is (#156): the shapes on screen during a switch are the board being left,
      // and this is where that board's own arrangement gets recorded. `leading` still waits,
      // because `rememberTerminalGeometry` files by the *active* board, which mid-switch is
      // already the one being entered.
      for (const sessionId of data.sessions) terminalHomesRef.current.set(terminalKeyOf(sessionId), geometry)
      if (!switching && !leading) leading = geometry

      reportTerminalGrid(element.id, geometry, data.sessions)
    }

    // And the same rect once more, where it outlives the page (#154). This is the one place
    // that sees a finished resize, so it is the one place that can remember one.
    //
    // The first block only, because that is the one a board comes back to: both doors put
    // every live session back into a single block, so there is one rect to restore and it is
    // the leading block's. Splitting a tab into a second block is an arrangement, and the
    // arrangement is derived and unsaved by decision — see `docs/terminal.md`.
    //
    // Never mid-gesture. `suppressed` is the reader's hand still on the shape, and what is
    // worth remembering is where it was let go; the un-suppressing call that follows every
    // gesture — the one that brings the overlay back — carries the settled rect.
    //
    // `leading` is left unset while a board switch is in flight, for the reason above.
    if (leading && !suppressed) rememberTerminalGeometry(leading)

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
   *
   * Nothing at all mid-switch. The blocks still on the canvas then belong to the board being
   * left, while `apiUrl` already names the board being entered — so the report would tell
   * one board's server about another board's block, for a session it has never heard of.
   * The new board's own blocks report for themselves the moment its scene lands.
   */
  const reportTerminalGrid = (
    elementId: string,
    size: { width: number; height: number },
    sessions: string[]
  ): void => {
    if (pendingSceneWorkspaceRef.current !== null) return
    // Measured here rather than remembered, and both halves of the cell: a row is the font's
    // own line box times the line height the emulator was given, a column is its advance
    // width, and only the browser that resolved the font knows either. Since #115 the face
    // is a web font, so "the font this page resolved" is not even fixed for the life of the
    // page. See `frontend/src/terminal-metrics.ts`.
    const font = terminalFontRef.current
    const grid = terminalGrid(size, font, terminalLineBox(font), terminalAdvance(font))
    const signature = `${grid.cols}x${grid.rows}`
    // Resolved once, here, rather than on each use: the debounce and the retry below both run
    // on a timer, and by then the reader may be on another board — whose `s1` is a different
    // shell entirely. The board is pinned for the same reason the keys are: a report that read
    // `apiUrl` when it finally fired would resize whichever board was in front by then, which
    // is a live shell repainting into a frame that is not its own.
    const board = sceneWorkspaceRef.current
    const keyed = new Map(sessions.map((id) => [id, terminalKeyOf(id)]))
    const stale = sessions.filter((id) => terminalGridRef.current.get(keyed.get(id)!) !== signature)
    if (stale.length === 0) return
    stale.forEach((id) => terminalGridRef.current.set(keyed.get(id)!, signature))

    const pending = terminalResizeTimersRef.current.get(elementId)
    if (pending) clearTimeout(pending)

    // A report that does not land is undone rather than forgotten. The signature stands
    // for "the server knows this size", so leaving it set after a failed request would
    // mean the block never mentions that size again — and with a PTY behind the session
    // that is not a stale label any more, it is a shell repainting to a width the block no
    // longer has.
    const report = (attempt: number): void => {
      terminalResizeTimersRef.current.delete(elementId)
      Promise.all(stale.map((sessionId) => fetch(apiUrlOn('/api/terminal/resize', board), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...grid })
      }).then((response) => {
        if (!response.ok) throw new Error(`the terminal refused the new size: ${response.status}`)
      }))).catch(() => {
        // Only while this is still the size being reported: a later gesture has its own
        // request, and retrying an overtaken one would report a size nobody is looking at.
        if (stale.some((id) => terminalGridRef.current.get(keyed.get(id)!) !== signature)) return
        if (attempt >= 2) { stale.forEach((id) => terminalGridRef.current.delete(keyed.get(id)!)); return }
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

  // The same report again, once the face has actually arrived.
  //
  // Since #115 the block draws in a web font, and a block placed before it loads measured
  // the fallback stack instead: five per cent wider a glyph, which is seven columns of a
  // default block reported away and never asked for again. Nothing goes wrong — the grid
  // only ever comes out *smaller* than the block can hold, so it is a narrower terminal
  // rather than a clipped one, which is exactly why it needs a line of its own rather than
  // being left to the next corner drag to fix.
  //
  // Mount only, and that is enough: a block placed after this has measured the real face
  // already, because `terminalAdvance` asks the browser every time rather than remembering.
  useEffect(() => {
    let cancelled = false
    void terminalFontReady().then(() => {
      if (cancelled) return
      for (const [elementId, block] of terminalGeometryRef.current) {
        reportTerminalGrid(elementId, block, block.sessions)
      }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The board's sessions are adopted when the board is shown, and one is opened if it has
  // none. Nothing is closed on the way out: a terminal you switched away from keeps its
  // shells and their transcripts, and the server closes every session when it goes down.
  //
  // Behind `boardReady` for the reason that flag exists: until the board has been resolved
  // this runs as `default`, and opening a shell for a board nobody asked for is worse here
  // than the wasted socket it was introduced for — it is a process.
  useEffect(() => {
    if (!excalidrawAPI || !boardReady) return
    // Keyed by element id, and the next board's shapes are not this one's: left in, the
    // blocks of the board being left would read as blocks this board has just had erased.
    terminalGeometryRef.current.clear()
    // The homes and the grids are *not* cleared, and since #156 they need not be: both are
    // keyed by board, so this board's entries were never the other board's to begin with —
    // and wiping them was itself losing something, namely where the reader had put this
    // board's terminal the last time they were on it. The wipe was also never the guard it
    // looked like: the scene of the board being left stays on screen through the reconnect,
    // so anything drawn in that window wrote the old geometry straight back in.
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
      if (event.code !== TERMINAL_HOTKEY_CODE || !isBoardHotkeyChord(event)) return

      // A text field owns the keyboard. The terminal is no longer one of them — since #177
      // this key is the board's even while the shell has the keyboard, and the shell is not
      // sent it either. `board-hotkeys.ts` is the whole rule.
      if (textEntryOwnsKeyboard(document.activeElement)) return

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

  /**
   * What Claude Code has spent, per environment on this machine.
   *
   * Not keyed on the active project, and that is the point: it describes the machines the
   * board runs agents on rather than any one repository, so switching tabs must not restart
   * it and must not empty it.
   *
   * A 404 is the answer for a board that was never asked to look — `EXCALIDRAW_CLAUDE_STATUS`
   * unset — and it ends the loop rather than retrying every minute for the life of the page:
   * that is a decision made when the server started, and nothing short of a restart changes
   * it. Visibility-gated for the same reason as the mirror above; a background tab reading
   * files nobody is looking at is pure cost.
   */
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const everyMs = claudeStatusPoll

    const read = async (): Promise<boolean> => {
      try {
        const response = await fetch('/api/claude-status')
        if (response.status === 404) return false
        if (!response.ok) return true
        const body = await response.json()
        if (!cancelled && Array.isArray(body?.environments)) {
          setClaudeStatus(body.environments as ClaudeEnvironmentStatus[])
        }
      } catch {
        // A dropped read is the previous reading kept, not the HUD blanked: the figures were
        // true a minute ago and the next poll is a minute away.
      }
      return true
    }

    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (document.visibilityState === 'visible' && !(await read())) return
      if (!cancelled) timer = setTimeout(() => { void tick() }, everyMs)
    }
    void tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [claudeStatusPoll])

  // On `window`, because Excalidraw never sees a key pressed outside its canvas, and the
  // point of this one is to work from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== MIRROR_HOTKEY_CODE || !isBoardHotkeyChord(event)) return

      // A label being typed into owns the keyboard. Excalidraw edits text in a real
      // textarea, so what has focus is the honest test — and it is the one that keeps
      // this from swallowing a keystroke meant for a card's title. One rule, in
      // `board-hotkeys.ts`, because a focused xterm is a textarea too and #177 is what
      // three copies of the tag test cost.
      if (textEntryOwnsKeyboard(document.activeElement)) return

      const api = excalidrawAPIRef.current
      if (!api) return
      if ((api.getAppState() as unknown as Record<string, unknown>).editingTextElement) return

      const mirror = api.getSceneElements().filter((element) => isMirrorElement(element))
      if (mirror.length === 0) return

      event.preventDefault()
      fitLegibly(api, mirror as unknown as ExcalidrawElement[], true)
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
      if (!isBoardHotkeyChord(event)) return

      if (textEntryOwnsKeyboard(document.activeElement)) return

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
      fitLegibly(api, [section] as unknown as ExcalidrawElement[], true)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Alt+Left and Alt+Right — one step through the parts of the section being read.
  //
  // A section's key says *which* half of the board; these say *where in it*. The parts are
  // read one after another, which is what makes them parts, so what they need is a step
  // rather than a key each: twelve chords for a board with twelve parts is a keyboard nobody
  // learns. Everything the step decides — which section the viewport is on, which part of it,
  // where one step lands — is `src/core/board-subsections.ts`, so that it can be checked
  // without a browser; what is left here is the scroll.
  //
  // **`preventDefault` whenever there was anything to step between, including at the ends.**
  // On Windows these are the browser's Back and Forward, and they are not reserved
  // accelerators: the page gets them first and a `preventDefault` keeps them, which
  // `scripts/check-alt-arrow-accelerator.mjs` measures with a real keypress rather than a
  // CDP-injected one. A step that has nowhere left to go still has to be swallowed, or the
  // last Alt+Right of a section navigates the reader out of the board entirely. A board that
  // draws no parts resolves to nothing, takes neither key, and keeps Back and Forward.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isBoardHotkeyChord(event)) return
      if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') return

      if (textEntryOwnsKeyboard(document.activeElement)) return

      const api = excalidrawAPIRef.current
      if (!api) return
      if ((api.getAppState() as unknown as Record<string, unknown>).editingTextElement) return

      const elements = api.getSceneElements()
      const target = stepBetweenSubsections(
        elements as unknown as BoardSectionElement[],
        viewportCentre(api),
        event.code === 'ArrowLeft' ? -1 : 1
      )
      if (!target) return

      const part = elements.find((element) => element.id === target.elementId)
      event.preventDefault()
      if (!part) return
      fitLegibly(api, [part] as unknown as ExcalidrawElement[], true)
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
      try {
        const result = await (await fetch('/api/workspaces')).json()
        // `configured` comes back in this payload and is deliberately not read: it is `true`
        // on every board now, and reading it was what decided whether the tab strip existed.
        if (result?.success) list = result.workspaces ?? []
      } catch (error) {
        console.warn('Could not load workspaces:', error)
      }
      if (cancelled) return

      setWorkspaces(list)
      const resolved = resolveInitialWorkspace(list)
      if (resolved) {
        activeWorkspaceRef.current = resolved
        // No switch to land: the first scene of the load *is* this board's, so the scene
        // and the active board agree from the start.
        sceneWorkspaceRef.current = resolved
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
      // The boards behind this one go with it. A warm board is a socket this page is holding
      // on somebody's behalf, and there is nobody left.
      for (const workspaceId of [...warmBoardsRef.current.keys()]) dropWarmBoard(workspaceId)
    }
  }, [])

  /**
   * What the browser tab says this window is.
   *
   * Since #261 the bar above the canvas has no title on it — a constant four words beside the
   * tabs that already name the board was the least informative thing in the row — so `<title>`
   * is the only place the name is left, and a reader with three projects open in three windows
   * reads them apart there and nowhere else. So the board goes first and the product second:
   * a tab strip is truncated to a handful of characters, and those characters should be the
   * variable half.
   *
   * The fallbacks are the states a board really sits in rather than defensive padding. Before
   * `/api/workspaces` has answered there is no list; a board nobody has added a project to yet
   * has nothing to be named after (#310 gave every canvas a registry, so that is now an empty
   * one rather than none, and the tab says the same thing either way); and this repository's
   * own board is *called* VibeMaxxing, which would otherwise render `VibeMaxxing —
   * VibeMaxxing`. All three land on the product name alone, which is what `index.html` already
   * said before any of this ran.
   */
  useEffect(() => {
    const board = workspaces.find((workspace) => workspace.id === activeWorkspace)
    const name = board?.name?.trim()
    document.title = name && name !== PRODUCT_NAME ? `${name} — ${PRODUCT_NAME}` : PRODUCT_NAME
  }, [workspaces, activeWorkspace])

  /**
   * The camera this board was last left at, put back on the way in.
   *
   * A switch restores through `finishBoardSwitch`, which has a board landing on the canvas to
   * hang the restore on. An ordinary page load has none — `pendingSceneWorkspaceRef` is null,
   * because the first scene of the load *is* this board's — so a reload had nothing restoring
   * it and opened at Excalidraw's own origin. This is that path.
   *
   * It does not wait for the scene: a viewport is three numbers, and it says nothing about
   * which shapes are on the canvas yet. Only a *remembered* camera is applied — a board with
   * none is left exactly where a load has always put it, at the origin at 100%, rather than
   * being fitted onto content this is deliberately not waiting for.
   *
   * Running it also opens the recording: until this has happened, `noteViewport` stands down
   * so that the mount's own `0, 0, 1` cannot be written over what is stored.
   */
  useEffect(() => {
    if (!excalidrawAPI || !boardReady || viewportOpenedRef.current) return
    viewportOpenedRef.current = true
    const seen = boardViewportsRef.current.get(activeWorkspaceRef.current)
    if (seen) applyViewport(excalidrawAPI, seen)
  }, [excalidrawAPI, boardReady])

  // The socket's own initial message is what normally fills the canvas; this covers the
  // case where it arrived before Excalidraw was mounted to receive it. It is a no-op once
  // this board has been loaded on this connection, which is what keeps a refresh to one
  // round of requests instead of the five it used to make.
  useEffect(() => {
    if (!excalidrawAPI || !boardReady) return
    void loadExistingElements()
  }, [excalidrawAPI, boardReady, activeWorkspace, isConnected])

  // ─── Boards kept warm ───────────────────────────────────────
  //
  // A socket belongs to one board for its lifetime, so leaving a board used to close it. The
  // board behind then had no connection, no updates and nothing on screen, and coming back
  // meant a new socket, a wait for `initial_elements`, and a canvas saying *Connecting* while
  // it happened. Nothing was ever *lost* — a shell outlives the socket watching it and
  // replays its scrollback on connect — but the redraw is what the reader is complaining
  // about in #173, and this is what turns coming back into one.
  //
  // A board switched away from keeps its socket and keeps applying what arrives to a copy of
  // its scene. Coming back paints that copy and adopts the socket, in the same turn as the
  // click. **A background board does not autosync and does not poll**: it has no scene on
  // screen to push, and nobody is reading its mirror. The board in front stays the only one
  // writing anything, which was the second question #173 left open.

  const warmBoardsRef = useRef<Map<string, WarmBoard>>(new Map())
  /** Bumped per visit, so the cap can tell which board has been waited on longest. */
  const warmVisitRef = useRef<number>(0)

  /** Let a board go cold: no socket, no copy, and a switch to it pays the old price. */
  const dropWarmBoard = (workspaceId: string): void => {
    const warm = warmBoardsRef.current.get(workspaceId)
    if (!warm) return
    warmBoardsRef.current.delete(workspaceId)
    if (warm.heartbeat) clearInterval(warm.heartbeat)
    warm.socket.onmessage = null
    warm.socket.onclose = null
    warm.socket.onerror = null
    try {
      warm.socket.close(1000)
    } catch (error) {
      console.warn('Could not close a background board:', error)
    }
  }

  /**
   * Keep a background board's copy of its scene up to date.
   *
   * The same merge the foreground does, against an array instead of against the canvas, and
   * deliberately only the messages that are about shapes. The terminal's are left alone
   * because there is one panel and it belongs to the board in front — a background board's
   * transcripts are read back over `GET /api/terminal` when it returns, the way they already
   * are on every switch. An export or a viewport request is left alone because a board nobody
   * is looking at cannot render one, which is what the server is told below.
   */
  const applyToWarmBoard = (warm: WarmBoard, data: WebSocketMessage): void => {
    const mergeIn = (incoming: Partial<ExcalidrawElement>[]): void => {
      if (incoming.length === 0) return
      const byId = new Map<string, Partial<ExcalidrawElement>>()
      incoming.forEach((element) => { if (element.id) byId.set(element.id, element) })
      const merged: Partial<ExcalidrawElement>[] = warm.elements.map((element) => {
        const found = element.id ? byId.get(element.id) : undefined
        if (!found) return element
        byId.delete(element.id as string)
        return { ...element, ...found }
      })
      merged.push(...byId.values())
      warm.elements = merged
    }

    switch (data.type) {
      case 'initial_elements':
        // An empty payload is left alone for the reason the foreground leaves it alone: away
        // from a switch it means a message that raced the store, not a board that was emptied.
        if (Array.isArray(data.elements) && data.elements.length > 0) {
          warm.elements = data.elements.map(cleanElementForExcalidraw)
        }
        if (data.files) warm.files.push(...Object.values(data.files as Record<string, unknown>))
        break

      case 'files_added':
        if (Array.isArray(data.files)) warm.files.push(...data.files)
        break

      case 'element_created':
      case 'element_updated':
        if (data.element) mergeIn([cleanElementForExcalidraw(data.element)])
        break

      case 'elements_batch_created':
        if (data.elements) mergeIn(data.elements.map(cleanElementForExcalidraw))
        break

      case 'element_deleted':
        if (data.elementId) {
          warm.elements = warm.elements.filter((element) => element.id !== data.elementId)
        }
        break

      case 'canvas_cleared':
        warm.elements = []
        warm.tombstones = []
        break

      default:
        break
    }
  }

  /** The quieter listener a socket gets while its board is off screen. */
  const watchInBackground = (workspaceId: string, warm: WarmBoard): void => {
    warm.socket.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        if ((data as { type?: string }).type === 'pong') {
          warm.awaitingPong = false
          return
        }
        applyToWarmBoard(warm, data)
      } catch (error) {
        console.error('Error parsing a background board message:', error, event.data)
      }
    }

    // A background board that loses its socket goes cold rather than retrying. There is
    // nobody behind it to be told, and a retry loop per board would be several reconnect
    // schedules running at once for boards nobody is looking at. The switch to it then does
    // what a switch has always done, which is the worst this can cost.
    warm.socket.onclose = () => { dropWarmBoard(workspaceId) }
    warm.socket.onerror = (error: Event) => {
      // Not a decision: an error is always followed by a close, and that is where it is made.
      console.warn(`Background board "${workspaceId}" reported an error:`, error)
    }

    // Its own heartbeat, because a half-open socket reads OPEN until TCP gives up — and here
    // nothing else would ever notice. Unanswered, the board goes cold and is reconnected the
    // ordinary way when the reader asks for it, rather than coming back showing an hour-old
    // scene it stopped being told about.
    warm.heartbeat = setInterval(() => {
      if (warm.socket.readyState !== WebSocket.OPEN || warm.awaitingPong) {
        dropWarmBoard(workspaceId)
        return
      }
      warm.awaitingPong = true
      try {
        warm.socket.send(JSON.stringify({ type: 'ping' }))
      } catch (error) {
        console.warn(`Background board "${workspaceId}" could not be pinged:`, error)
        dropWarmBoard(workspaceId)
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  /** Past the cap, the board the reader has been away from longest goes cold. */
  const trimWarmBoards = (): void => {
    if (warmBoardsRef.current.size <= WARM_BOARD_LIMIT) return
    const surplus = warmBoardsRef.current.size - WARM_BOARD_LIMIT
    ;[...warmBoardsRef.current.entries()]
      .sort((one, other) => one[1].visitedAt - other[1].visitedAt)
      .slice(0, surplus)
      .forEach(([workspaceId]) => dropWarmBoard(workspaceId))
  }

  /**
   * Leave a board running instead of closing it.
   *
   * Only a board whose own scene is the one on screen. During a second switch made before the
   * first has landed the socket already names the board being entered while the canvas still
   * draws the one before it, and a copy taken then would file one project's shapes under
   * another — the same crossing #156 was about, one layer down. That board is closed as it
   * always was: one switch paying the old price beats a warm board that is wrong.
   */
  const keepBoardWarm = (workspaceId: string): void => {
    const socket = websocketRef.current
    const api = excalidrawAPIRef.current
    if (!socket || !api) return
    if (socket.readyState !== WebSocket.OPEN) return
    if (pendingSceneWorkspaceRef.current !== null) return
    if (sceneWorkspaceRef.current !== workspaceId) return

    const scene = api.getSceneElementsIncludingDeleted() as unknown as Partial<ExcalidrawElement>[]
    websocketRef.current = null
    const warm: WarmBoard = {
      socket,
      elements: scene.filter((element) => !element.isDeleted),
      tombstones: scene.filter((element) => element.isDeleted),
      files: [],
      heartbeat: null,
      awaitingPong: false,
      visitedAt: warmVisitRef.current++
    }

    // The server counts sockets to answer "is any browser on this board", and both routes
    // that ask a browser to *do* something — render an export, move its camera — refuse at
    // once when the answer is none. A socket held open for a board nobody is looking at would
    // turn that refusal into a thirty-second timeout, so it says which of the two it is: this
    // one is still listening, it is no longer watching.
    try {
      socket.send(JSON.stringify({ type: 'watching', active: false }))
    } catch (error) {
      console.warn('Could not hand a board to the background:', error)
    }

    warmBoardsRef.current.set(workspaceId, warm)
    watchInBackground(workspaceId, warm)
    trimWarmBoards()
  }

  /**
   * Put a board that stayed live back on screen.
   *
   * Everything a reconnect used to do, minus the reconnecting: the socket is adopted as this
   * page's, the scene it kept is painted, and the switch finishes in the same turn as the
   * click — so the pill never leaves *Connected* and nothing is pulled over HTTP. The loader
   * is marked as having already run for this connection, or the effect that follows a switch
   * would fetch the very board that is on the canvas.
   */
  const resumeWarmBoard = (workspaceId: string): boolean => {
    const warm = warmBoardsRef.current.get(workspaceId)
    if (!warm) return false
    const api = excalidrawAPIRef.current
    if (!api || warm.socket.readyState !== WebSocket.OPEN) {
      dropWarmBoard(workspaceId)
      return false
    }

    warmBoardsRef.current.delete(workspaceId)
    if (warm.heartbeat) clearInterval(warm.heartbeat)

    websocketRef.current = warm.socket
    attachForegroundHandlers(warm.socket)
    try {
      warm.socket.send(JSON.stringify({ type: 'watching', active: true }))
    } catch (error) {
      console.warn('Could not bring a board back to the front:', error)
    }
    reconnectAttemptsRef.current = 0
    startHeartbeat(warm.socket)
    setConnectionState('connected')

    // A generation of its own, and the loader marked done for it: `loadExistingElements` runs
    // once per board per connection, and this connection has already delivered this board.
    connectionGenerationRef.current += 1
    loadedSceneKeyRef.current = sceneKey()
    filesFromSocketRef.current = sceneKey()

    if (warm.files.length > 0) {
      api.addFiles(warm.files as Parameters<ExcalidrawImperativeAPI['addFiles']>[0])
    }
    applySceneUpdateWithoutAutoSync(api, {
      elements: [
        ...convertElementsPreservingImageProps(warm.elements),
        ...warm.tombstones
      ] as ExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER
    })
    // The moment the swap happened: `sceneWorkspaceRef` moves on and the camera goes back.
    finishBoardSwitch()
    return true
  }

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
   *
   * A board that was kept warm skips all of that: there is nothing to wait for, so the
   * replacement happens here, in the same turn as the click.
   */
  const switchWorkspace = (workspaceId: string): void => {
    if (workspaceId === activeWorkspaceRef.current) return

    // Written down against the board whose shapes are on screen, which during a second
    // switch made before the first one landed is not the board `activeWorkspaceRef` names.
    rememberViewport(sceneWorkspaceRef.current)

    // The board being left keeps its socket, if what is on screen is really its own scene.
    // Before anything below names the board being entered: this reads the board being left,
    // and this is the last line where the two still agree.
    stopHeartbeat()
    keepBoardWarm(activeWorkspaceRef.current)

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
    // columns decide where a card dragged on the new board was dropped.
    //
    // Where each region was placed is kept, though, filed under the board it belongs to
    // (`mirrorOriginsRef`). Dropping it here was the same defect #99 fixed, arriving on a
    // slower cadence: coming back re-decided the origin from whatever the canvas looked like
    // at that moment, which on a board holding only a mirror and a terminal is nothing at
    // all — so the region went to a constant and landed on the block (#188). Keying it by
    // board is what the reset was really for, and a map does that without forgetting.
    projectBoardRef.current = { board: null, columns: [], errors: {}, implementing: {}, queue: null, signature: '' }

    pendingSceneWorkspaceRef.current = workspaceId
    holdAutoSyncForSwitch()

    // Whatever is left of the previous connection. `keepBoardWarm` takes the socket when the
    // board it belongs to is one being kept; what can still be here is a board that was not.
    if (websocketRef.current) {
      websocketRef.current.onclose = null
      websocketRef.current.close()
      websocketRef.current = null
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    reconnectAttemptsRef.current = 0

    // A board that stayed live is put back here and now: no socket, no pull, no *Connecting*.
    if (resumeWarmBoard(workspaceId)) return

    // A socket belongs to one board for its lifetime, so a board that went cold — or was
    // never visited on this load — is still a reconnect.
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

  /**
   * A tab dragged, or moved with the chord, to a new place on the strip.
   *
   * Shown before it is written and reconciled against what the route answers with, the way
   * the `+` and the settings dialog already are: the strip is what the hand is on, and a tab
   * that only moved once the round trip came back would feel like a strip that ignored the
   * first attempt. The registry is the store — an order kept per browser would drift between
   * two windows on the same board, while everything else about a project already persists in
   * files the operator owns.
   *
   * **A refusal puts the strip back**, rather than leaving the reader looking at an order the
   * board does not have. The list is captured before the optimistic write for exactly that,
   * and the restore is unconditional on failure: the alternative is a tab that stays where it
   * was dropped and goes back on the next reload, which is the harder thing to notice.
   */
  const reorderWorkspaces = (ids: string[]): void => {
    const previous = workspaces
    const byId = new Map(previous.map((workspace) => [workspace.id, workspace]))
    const optimistic = ids
      .map((id) => byId.get(id))
      .filter((workspace): workspace is WorkspaceSummary => Boolean(workspace))
    if (optimistic.length !== previous.length) return
    setWorkspaces(optimistic)

    void (async () => {
      try {
        const result = await (await fetch('/api/workspaces/order', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        })).json()
        if (!result?.success) throw new Error(result?.error ?? 'the board refused the new order')
        // Reconciled rather than kept: the server answers with the list it actually loaded,
        // which is the only account of the order that survives a reload.
        setWorkspaces(result.workspaces ?? optimistic)
      } catch (error) {
        console.warn('Could not save the project order:', error)
        setWorkspaces(previous)
      }
    })()
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
        issueStartedAt: (custom.issueStartedAt as string) ?? null,
        issueEndedAt: (custom.issueEndedAt as string) ?? null,
        images: Array.isArray(custom.issueImages) ? (custom.issueImages as string[]) : [],
        implementState: (custom.implementState as IssueTarget['implementState']) ?? null,
        implementUrl: (custom.implementUrl as string) ?? null,
        implementError: (custom.implementError as string) ?? null,
        implementStartedAt: (custom.implementStartedAt as string) ?? null,
        implementEndedAt: (custom.implementEndedAt as string) ?? null,
        // An authored block has no column to read, the way `resolvePanelTarget` says: it is
        // either on a board with no project or one poll away from being retired by the card
        // that replaces it, and the route is the authority in both cases.
        recreatable: true
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
    // Not while a reconnect still owes the server a write. This replaces the scene with what
    // the store holds, and the store is the one place the owed change has not reached — the
    // effect that watches `isConnected` gets here within a frame of the socket opening, well
    // before the flush lands (#225). `socket.onopen` calls this itself once it has.
    if (owedSyncFlushRef.current) return
    const key = sceneKey()
    if (loadedSceneKeyRef.current === key) return
    loadedSceneKeyRef.current = key
    try {
      const response = await fetch(apiUrl('/api/elements'))
      const result: ApiResponse = await response.json()

      if (result.success && result.elements && result.elements.length > 0) {
        // The socket's own path waits in `handleWebSocketMessage`; this one is the other way a
        // board first reaches the canvas, and measures the same way (#234).
        await canvasFontsReady(result.elements)
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

  /**
   * The handlers a socket has while its board is the one on screen.
   *
   * Separate from opening one, because a socket now arrives here two ways: newly connected,
   * and adopted back from the background when the reader returns to a board that stayed live.
   * `onopen` is not among them — a socket being adopted opened long ago.
   */
  const attachForegroundHandlers = (socket: WebSocket): void => {
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
    // tab never redraws with another board's shapes. And who it is, so that a write this
    // page sends over HTTP is not read back to it over here — see `CLIENT_ID`.
    const wsUrl = `${protocol}//${window.location.host}`
      + `?workspace=${encodeURIComponent(activeWorkspaceRef.current)}`
      + `&client=${encodeURIComponent(CLIENT_ID)}`

    connectionGenerationRef.current += 1
    const socket = new WebSocket(wsUrl)
    websocketRef.current = socket

    socket.onopen = () => {
      reconnectAttemptsRef.current = 0
      setConnectionState('connected')
      startHeartbeat(socket)

      // A write owed from while the socket was down goes *up* before any scene is taken
      // *down*. Both of the things that fill the canvas on a connection — `initial_elements`
      // and the loader below — replace it from the store, and the store is precisely what
      // never heard of the change made in the dark; either landing first is #225, a draft
      // taken off the canvas by the reconnect that was supposed to save it. So the flush is
      // what the loader waits for, and while it is out an arriving scene is merged instead
      // of substituted.
      //
      // A flush that does not land leaves the write owed rather than clearing it, and the
      // scene is left alone: the next change, or the next reconnect, comes back to it. The
      // one thing not done here is replacing the canvas with a store that is behind it.
      if (autoSyncPendingRef.current) {
        owedSyncFlushRef.current = true
        void flushAutoSync().then((landed) => {
          owedSyncFlushRef.current = false
          if (!landed) {
            autoSyncPendingRef.current = true
            return
          }
          if (excalidrawAPIRef.current) void loadExistingElements()
        })
        return
      }

      // The ref, not the closure: this handler was created before Excalidraw mounted on
      // the very load it matters for, and the closure would still say it had not.
      if (excalidrawAPIRef.current) {
        setTimeout(() => { void loadExistingElements() }, 100)
      }
    }

    attachForegroundHandlers(socket)
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    if (!excalidrawAPIRef.current) {
      return
    }

    // Before anything is converted, because converting is what measures. Every path below ends
    // in `convertElementsPreservingImageProps`, and `newTextElement` inside it records the
    // width the browser measures *now* — the fallback font's, on a cold profile, kept for good
    // (#234). One `await` at the top of the funnel rather than at each of them: the messages
    // still arrive in order, because each handler suspends at the same point and resumes in
    // the order it suspended.
    await canvasFontsReady(data.elements ?? (data.element ? [data.element] : null))

    const excalidrawAPI = excalidrawAPIRef.current
    if (!excalidrawAPI) {
      return
    }

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      /**
       * Fold a message's elements into the scene that is already here.
       *
       * The arrival wins field by field, which is what every message but one wants: it is the
       * server correcting this page. `keepLocal` turns that around for the one case where the
       * server is the one that is behind — a reconnect whose owed write has not landed yet, so
       * the store's copy of a block is the copy from *before* what was typed into it while the
       * socket was down (#225). The pull that follows the flush is what puts the two back in
       * step, so the reversal lasts only as long as that window.
       */
      const mergeAndApplySceneElements = (
        incomingElements: Partial<ExcalidrawElement>[],
        options: { keepLocal?: boolean } = {}
      ): void => {
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
          return options.keepLocal ? { ...incoming, ...element } : { ...element, ...incoming }
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
          // A reconnect still carrying an owed write is the one case where the store is
          // behind the canvas rather than ahead of it: what was drawn while the socket was
          // down is here and nowhere else, and a wholesale replacement would take it away
          // moments before the flush that would have saved it (#225). Merged instead — the
          // store still wins field by field for everything it knows about, and what only
          // this page knows about stays. A board switch is untouched: there the whole point
          // is that another board's scene is replaced.
          const mergeRatherThanReplace = owedSyncFlushRef.current && !landingOnANewBoard
          if (data.elements && data.elements.length > 0) {
            const cleanedElements = data.elements.map(cleanElementForExcalidraw)
            if (mergeRatherThanReplace) {
              mergeAndApplySceneElements(cleanedElements, { keepLocal: true })
            } else {
              const convertedElements = convertElementsPreservingImageProps(cleanedElements)
              applySceneUpdateWithoutAutoSync(excalidrawAPI, {
                elements: convertedElements,
                captureUpdate: CaptureUpdateAction.NEVER
              })
            }
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

  /**
   * Main sync function. Answers whether the scene actually reached the server.
   *
   * The answer matters to one caller — the flush a reconnect makes before it accepts a scene
   * back (#225). Everything else fires and forgets, as it did before: an autosync that fails
   * is retried by the next change, and there is nothing for it to decide.
   */
  const syncToBackend = async (options: { silent?: boolean } = {}): Promise<boolean> => {
    const { silent = false } = options

    // Read through the ref: WS message handlers attached at mount capture a
    // stale closure where the excalidrawAPI state is still null.
    const api = excalidrawAPIRef.current
    if (!api) {
      console.warn('Excalidraw API not available')
      return false
    }

    if (syncInFlightRef.current) {
      return false
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
        return true
      }
      const error: ApiResponse = await response.json()
      console.error('Sync failed:', error.error)
      if (!silent) {
        setSyncStatus('error')
      }
    } catch (error) {
      console.error('Sync error:', error)
      if (!silent) {
        setSyncStatus('error')
      }
    } finally {
      syncInFlightRef.current = false
    }
    return false
  }

  /**
   * Put the scene on the server now, and wait for it to land.
   *
   * Everything that addresses a block by element id has to go through this first. The server
   * resolves that id out of its own store, and the only thing that puts a block there is the
   * autosync — which runs `AUTO_SYNC_DEBOUNCE_MS` after the last change. Finish an edit,
   * click, and the request overtakes the sync: `Element pbdraft-… not found`, on a block that
   * is on screen (#179).
   *
   * #100 stopped a refused schedule from being *dropped*; this is the other half, the wait
   * for it. Neither replaces the other — the owed write is what saves the change when nobody
   * clicks at all.
   *
   * **A sync already on the wire does not count.** It read the scene before this change, so
   * it is waited out and then followed by one that did see it — the same reasoning
   * `scheduleAutoSync` applies to its own timer. The wait is bounded: if it never frees, the
   * request goes anyway, which is exactly what happened before this existed.
   */
  const flushAutoSync = async (): Promise<boolean> => {
    const deadline = Date.now() + FLUSH_WAIT_MS
    while (syncInFlightRef.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, FLUSH_POLL_MS))
    }

    // The debounce is spent: what it was waiting to write is being written now.
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }
    // Nothing is owed once this runs — it writes the scene as it stands, which is every
    // change that was refused while the timer was out. The same rule the timer applies.
    autoSyncPendingRef.current = false

    return syncToBackend({ silent: true })
  }

  const scheduleAutoSync = (): void => {
    if (!userInteractedRef.current) {
      return
    }
    // Refused, not dropped — the other half of the rule below, and the other reason a write
    // is owed. A change made while the socket is down used to return from here bare: nothing
    // was armed and nothing would ever arm it, so the change waited for a later one that
    // happened to find the socket up. That is #92's defect in the branch beside it, and #225
    // is what it cost — a draft typed into the dark, and then a reconnect that replaced the
    // scene from a store which had never heard of it. `socket.onopen` is what comes back to
    // this one, the way `releaseAutoSyncSuppression` comes back to the next.
    if (!isConnected || !excalidrawAPI) {
      autoSyncPendingRef.current = true
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

  const toggleChrome = (): void => {
    setChromeHidden((hidden) => {
      const next = !hidden
      try {
        window.localStorage?.setItem(CHROME_STORAGE_KEY, next ? 'hidden' : 'visible')
      } catch (error) {
        console.warn('Failed to save the menu setting to localStorage:', error)
      }
      return next
    })
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
    // `data-chrome` beside `data-theme`, and for the same reason: both are settings the
    // stylesheet in `index.html` reads, and both have to be readable from *above* the
    // Excalidraw subtree — the rules that hide its menus select down into it from here.
    <div className="app" data-theme={theme} data-chrome={chromeHidden ? 'hidden' : 'visible'}>
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

      {/*
        One bar, since #261: the boards on the left, what you can do to this one on the right.

        The `<h1>Excalidraw Canvas</h1>` that used to open the row is gone, and it is the thing
        that had to give. It said the same four words on every board of every project, while
        the tabs beside it say which board this is — a constant title next to the variable one
        is the least informative use of a row that now has to hold both. The document still has
        its name in `<title>`, where a browser tab reads it.

        The strip is a child of the header rather than the header being a branch of the strip,
        and that mattered while the strip could disappear: the connection pill, Sync to Backend
        and Clear Canvas belong to a board with no projects too. The strip stays now — it
        carries the control that adds the first project — but the nesting is still right for
        the same reason.
      */}
      <div className="header">
        <WorkspaceTabs
          workspaces={workspaces}
          activeId={activeWorkspace}
          onSelect={switchWorkspace}
          onAdd={() => setWorkspaceDialog('add')}
          onConfigure={() => setWorkspaceDialog('config')}
          onReorder={reorderWorkspaces}
        />
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

          {/*
            In the header, which is a sibling of the canvas container rather than a child of
            it — so this is the one control that cannot hide itself, and there is always a
            way back. Excalidraw's own two modes are keyboard-only for the same reason and
            answer it worse: `Alt+Z` leaves the hamburger and the toolbar where they are, and
            `Alt+R` takes editing with it.
          */}
          <button
            className="btn-secondary chrome-toggle"
            onClick={toggleChrome}
            aria-pressed={chromeHidden}
            title={chromeHidden
              ? 'Show Excalidraw’s toolbar, properties panel and menu'
              : 'Hide Excalidraw’s toolbar, properties panel and menu. Tools keep their keyboard shortcuts.'}
          >
            {chromeHidden ? 'Show Menus' : 'Hide Menus'}
          </button>

          <button className="btn-secondary" onClick={clearCanvas}>Clear Canvas</button>

          {/*
            The one control here that acts on the server rather than on the canvas, so it sits
            at the end of the row where the destructive things already are. It is
            loopback-guarded on the server and disabled off it, and everything it costs is on
            the confirmation it opens.
          */}
          <RestartButton />

          {/*
            Last in `.controls`, which is the header's right-hand group — so this is the
            top-right corner of the *page*. The canvas viewport's top-right corner is
            `layer-ui__wrapper__top-right`, which Excalidraw owns and which the library
            trigger already sits in; putting a row of this board's own text in there would
            fight that grid and would go with the rest of the chrome. Here it survives
            `Hide Menus`, which only ever touches Excalidraw's own.
          */}
          <ClaudeStatusHud environments={claudeStatus} pollMs={claudeStatusPoll} />
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
          //
          // And clipped to it, which is #153. A terminal card is drawn at its block's bounds
          // in viewport coordinates with no clamp, so a block panned above the top of the
          // canvas gets a negative `top` — and with nothing clipping this box, the card was
          // painted across the project tabs and the header row, taking their clicks with it.
          // The documentation card never showed it because its placement is clamped into the
          // viewport before it is drawn; this one is pinned to its shape on purpose, so
          // clipping is the answer rather than moving it back on screen. The card should
          // stop where the board stops, the way the rectangle underneath it already does.
          //
          // Safe for Excalidraw: everything it draws — its islands, its popups, its
          // `.excalidraw-modal-container` — is inside `.excalidraw`, which is itself
          // `overflow: hidden` and fills this box exactly. Nothing of its own was reaching
          // past this edge to begin with, so this clips only what we put here.
          style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
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
              // Where this board is being looked at, so a reload puts it back.
              noteViewport(appState as unknown as { scrollX?: number; scrollY?: number; zoom?: { value?: number } })
              syncSelectedDoc(appState)
              reportSectionClaims(_elements)
              reportSubsectionClaims(_elements)
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
            // The terminal panels, in the coordinates the card is placed in — the same
            // arithmetic produced both, a few lines apart. Placement opens the card on a
            // side clear of them where there is one, because these are on its layer and
            // drawn after it, so an overlap covers the card rather than the terminal
            // (#241). Suppressed panels count: one is hidden for the length of a drag and
            // comes back where it was, and a card that moved into the space and jumped out
            // of it again when the hand let go would be worse than one that stayed put.
            obstacles={terminalViews.map((view) => view.rect)}
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
            onAdoptIssue={adoptIssueOnBlock}
            onAddComment={addObservationToIssue}
            onRecreateIssue={recreateIssue}
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
              // The four keys the board has claimed, answered on the press. The overlay sees
              // a keystroke before any `window` listener does, so it has to ask rather than
              // be told — see `isBoardHotkey` and `board-hotkeys.ts`.
              isBoardHotkey={isBoardHotkey}
              fontSize={terminalFont}
              onFontSize={changeTerminalFont}
              // The one thing about the board this overlay cannot work out for itself. Dark
              // mode is a filter Excalidraw puts on its own canvas, and the card is a sibling
              // of that canvas rather than a child of it, so nothing filters it — told
              // nothing, it paints a bright card over a block the filter has darkened.
              theme={theme}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default App
