import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import net from 'net';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import {
  elements,
  files,
  snapshots,
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  ExcalidrawFile,
  WebSocketMessage,
  ElementCreatedMessage,
  ElementUpdatedMessage,
  ElementDeletedMessage,
  BatchCreatedMessage,
  SyncStatusMessage,
  InitialElementsMessage,
  Snapshot,
  normalizeFontFamily
} from './types.js';
import { z } from 'zod';
import WebSocket from 'ws';
import { isMainModule } from './core/entry.js';
import { writePidFile, removePidFile } from './core/pidfile.js';
import {
  addWorkspace,
  loadWorkspaces,
  reorderWorkspaces,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  Workspace
} from './core/workspaces.js';
import { BoardScene, parseBoardScene } from './core/board-seed.js';
import { listDirectories } from './core/directory-browse.js';
import {
  AgentCommands, AgentHost, agentCommandFor, runIssueAgent, runReviseAgent, runsHeadless,
  withoutPrintFlags
} from './core/issue-agent.js';
import { AgentUsage } from './core/agent-usage.js';
import { issueImageIds, materializeIssueImages, MaterializedImages, NO_IMAGES } from './core/issue-images.js';
import {
  readProjectBoard,
  moveCard,
  moveIssueToColumn,
  findColumn,
  inProgressColumn,
  todoColumn,
  DEFAULT_TODO_COLUMN,
  NoProjectConfigured,
  NotOnThisBoard
} from './core/project-board.js';
import {
  queueEnabled,
  queuedWorkspaces,
  setQueueEnabled,
  startableCards
} from './core/implement-queue.js';
import { MIRROR_DOC_KEY } from './core/project-board-layout.js';
import { commentOnIssue, fetchIssue, isIssueUrl } from './core/github-issue.js';
import type { IssueDetail } from './core/github-issue.js';
import { IssueMemo, memoWindow } from './core/issue-memo.js';
import {
  PtyModule,
  TERMINAL_SESSION_LIMIT,
  TerminalSession,
  TerminalSessionOptions,
  loadPty,
  shellCommandFrom
} from './core/terminal-session.js';
import { issueBlockAppearance } from './core/issue-appearance.js';
import { preserveServerAuthored } from './core/element-authorship.js';
import { runImplementAgent } from './core/implement-agent.js';
import {
  ImplementRecord,
  ImplementUsage,
  clearImplement,
  isImplementing,
  listImplement,
  readImplement,
  runningImplements,
  writeImplement
} from './core/implement-state.js';
import {
  HeldWorktree,
  ImplementWorktree,
  ensureWorktree,
  releaseWorktree
} from './core/implement-worktree.js';
import { describeInterrupted, interruptedRuns } from './core/implement-recovery.js';
import { layoutLabel, DEFAULT_BOUND_TEXT_FONT_SIZE } from './core/text-layout.js';
import {
  elementsFor,
  workspaceIdFrom,
  normalizeWorkspaceId,
  activeWorkspaceIds,
  DEFAULT_WORKSPACE_ID
} from './core/element-store.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files from the build directory
const staticDir = path.join(__dirname, '../dist');
app.use(express.static(staticDir));
// Also serve frontend assets
app.use(express.static(path.join(__dirname, '../dist/frontend')));
// Serve Excalidraw fonts so the font subsetting worker can fetch them for export
app.use('/assets/fonts', express.static(
  path.join(__dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/fonts')
));

/**
 * Whether `incoming` should win over `current` when both describe the same element.
 *
 * Mirrors how Excalidraw reconciles collaborative scenes: `version` counts edits and
 * decides; `versionNonce` only breaks ties, where it is arbitrary but identical on
 * every peer, so all of them converge on the same winner instead of flip-flopping.
 */
function isNewerVersion(incoming: any, current: any): boolean {
  const incomingVersion = typeof incoming?.version === 'number' ? incoming.version : 0;
  const currentVersion = typeof current?.version === 'number' ? current.version : 0;

  if (incomingVersion !== currentVersion) return incomingVersion > currentVersion;

  const incomingNonce = typeof incoming?.versionNonce === 'number' ? incoming.versionNonce : 0;
  const currentNonce = typeof current?.versionNonce === 'number' ? current.versionNonce : 0;

  // Lower nonce wins, matching Excalidraw, so the choice is stable across peers.
  return incomingNonce < currentNonce;
}

// WebSocket connections
const clients = new Set<WebSocket>();

/** Elements held across every workspace — for counters that describe the process. */
function totalElementCount(): number {
  return activeWorkspaceIds().reduce((total, id) => total + elementsFor(id).size, 0);
}

/** Which board each socket is watching, so events do not cross boards. */
const socketWorkspaces = new WeakMap<WebSocket, string>();

/**
 * Whether a socket's board is the one its reader is actually looking at.
 *
 * Since #173 a browser keeps the socket of a board it has switched away from, so that the
 * board stays up to date and coming back is a redraw rather than a reconnect. Such a socket
 * still *receives* — that is the whole point of it — but it has no scene on screen, so it
 * cannot render an export or answer a request to move a camera. Without this distinction
 * `clientsWatching` would say a board has a browser on it and both of those routes would
 * wait out their timeout instead of being refused at once.
 *
 * True by default: a socket that never says otherwise is a browser on the board it named,
 * which is every socket before this existed and every socket from any other client.
 */
const socketWatching = new WeakMap<WebSocket, boolean>();

/**
 * What a socket calls itself, when it calls itself anything.
 *
 * A page's socket and a page's HTTP writes are two connections, and nothing tied them
 * together — so a write over HTTP came back to its own author over the socket, carrying the
 * server's whole copy of the element rather than the field that was written. Through a burst
 * of typing the autosync is a debounce behind, so that copy is the block as it was before it
 * grew: the echo hands a container its template height back while the label bound to it is
 * twice that (#190). The socket names itself on connect, `?client=<id>`, and a write names
 * the same id in `x-client-id`; that is the whole of the pairing.
 */
const socketClients = new WeakMap<WebSocket, string>();

/** Who a request says it is, for the one purpose of not answering it back to itself. */
function clientIdFrom(req: Request): string | undefined {
  const named = req.headers['x-client-id'];
  const id = Array.isArray(named) ? named[0] : named;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

/**
 * Broadcast to the clients watching one workspace.
 *
 * Omitting `workspaceId` reaches every client — right for server-wide notices, wrong
 * for element events, which would make one board redraw with another board's shapes.
 *
 * `exceptClientId` leaves out the sockets of the client that asked for this, and nobody
 * else. An id no socket answers to excludes nobody, which is what makes it safe to send
 * from anything: a client that never names itself is told everything, as every client was
 * before this existed.
 */
function broadcast(message: WebSocketMessage, workspaceId?: string, exceptClientId?: string): void {
  const data = JSON.stringify(
    workspaceId ? { ...message, workspace: workspaceId } : message
  );
  clients.forEach(client => {
    try {
      if (client.readyState !== WebSocket.OPEN) return;
      if (workspaceId && socketWorkspaces.get(client) !== workspaceId) return;
      if (exceptClientId && socketClients.get(client) === exceptClientId) return;
      client.send(data);
    } catch (err) {
      logger.warn('Failed to send to client, removing');
      clients.delete(client);
    }
  });
}

/**
 * How many browsers are on one board.
 *
 * Two routes ask the browser to do something rather than telling it something — move its
 * camera, render its scene — and both used to ask *everyone*, then check that somebody
 * anywhere was connected. On a single-board setup those are the same question. With a tab
 * strip they are not: a request naming one project scrolled every project open in every
 * window, and an export of one board had every other board answer with its own scene
 * (#156). Both now ask one board, so both have to know whether that board has a browser
 * on it — `clients.size` would say yes on the strength of a tab watching something else.
 */
function clientsWatching(workspaceId: string): number {
  let watching = 0;
  clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (socketWorkspaces.get(client) !== workspaceId) return;
    // A socket kept open for a board its reader has switched away from is listening, not
    // watching. It has no scene on screen to render or to scroll.
    if (socketWatching.get(client) === false) return;
    watching += 1;
  });
  return watching;
}

function normalizeLineBreakMarkup(text: string): string {
  return text
    .replace(/<\s*b\s*r\s*\/?\s*>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

// WebSocket connection handling
wss.on('connection', (ws: WebSocket, request) => {
  // A socket belongs to one board for its lifetime: the client reconnects when it
  // switches tabs, which is simpler than multiplexing workspaces over one socket.
  const requestUrl = new URL(request.url ?? '/', 'http://localhost');
  const workspaceId = normalizeWorkspaceId(requestUrl.searchParams.get('workspace'));
  socketWorkspaces.set(ws, workspaceId);
  // Optional, and unnamed is the state every socket was in before #190: a client that does
  // not say who it is is simply told everything.
  const clientId = requestUrl.searchParams.get('client')?.trim();
  if (clientId) socketClients.set(ws, clientId);
  // A socket is watching until its own client says it is in the background: a browser opens
  // one for the board it is about to show.
  socketWatching.set(ws, true);
  clients.add(ws);
  logger.info(`New WebSocket connection established (workspace: ${workspaceId})`);

  // Send current elements to new client, with the files this board's own elements point
  // at — every board's files went out here, on every connect, which is the same megabytes
  // as the unscoped `GET /api/files` and paid for by every reader of every board.
  const filesObj = filesForWorkspace(workspaceId);
  const initialMessage: InitialElementsMessage & { files?: Record<string, ExcalidrawFile> } = {
    type: 'initial_elements',
    elements: Array.from(elementsFor(workspaceId).values()),
    ...(Object.keys(filesObj).length > 0 ? { files: filesObj } : {})
  };
  ws.send(JSON.stringify(initialMessage));

  // Send sync status to new client
  const syncMessage: SyncStatusMessage = {
    type: 'sync_status',
    elementCount: elementsFor(workspaceId).size,
    timestamp: new Date().toISOString()
  };
  ws.send(JSON.stringify(syncMessage));

  // A terminal session outlives the socket watching it — a reload, a tab switched away and
  // back, a second window — so every live transcript is replayed here rather than being lost
  // with whichever socket happened to receive it.
  //
  // The whole set, and sent even when it is empty, because this is what a viewer reconciles
  // its tabs against: a session that ended while the tab was disconnected has to be *absent*
  // from a list rather than merely unmentioned, or the block would keep a tab for a shell
  // that has gone. Gated on the feature being on rather than on there being a session, for
  // the reason the old code gated on the session: a board that never turned this on is told
  // nothing at all about it.
  if (TERMINAL_SETTING) {
    ws.send(JSON.stringify({
      type: 'terminal_sessions',
      workspace: workspaceId,
      sessions: Array.from(terminalSessionsFor(workspaceId).values()).map(terminalReplay)
    }));
  }

  // A browser cannot send a protocol ping, so the liveness check clients use is an
  // application message and answering it is the whole contract. Without an answer a
  // half-open socket reads OPEN until TCP gives up, which is minutes of a canvas that
  // looks connected and receives nothing.
  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      // The other thing a client says: whether this board is the one on its screen. It stays
      // subscribed either way — see `socketWatching`.
      if (message?.type === 'watching') socketWatching.set(ws, message.active !== false);
    } catch {
      // Clients talk to this server over HTTP; anything else arriving here is not ours.
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    socketWorkspaces.delete(ws);
    socketWatching.delete(ws);
    socketClients.delete(ws);
    logger.info('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    clients.delete(ws);
    socketWorkspaces.delete(ws);
    socketWatching.delete(ws);
    socketClients.delete(ws);
  });
});

// Schema validation
const CreateElementSchema = z.object({
  id: z.string().optional(), // Allow passing ID for MCP sync
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  // Arrow-specific properties
  points: z.any().optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Arrow binding properties (preserved for Excalidraw frontend)
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  // Image-specific properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
  // Standard Excalidraw integration fields. Both already survive a frontend sync,
  // which spreads the element unvalidated — accepting them here removes an
  // asymmetry where the browser could set them but the API could not.
  link: z.string().nullable().optional(),
  customData: z.record(z.unknown()).optional(),
  // A shape's label is a text element bound to it through containerId; without this
  // the binding is stripped and the label becomes a free-floating text.
  containerId: z.string().nullable().optional(),
});

const UpdateElementSchema = z.object({
  id: z.string(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  originalText: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  points: z.array(z.union([
    z.tuple([z.number(), z.number()]),
    z.object({ x: z.number(), y: z.number() })
  ])).optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Arrow binding properties (preserved for Excalidraw frontend)
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  // Image-specific properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
  link: z.string().nullable().optional(),
  customData: z.record(z.unknown()).optional(),
  // A shape's label is a text element bound to it through containerId; without this
  // the binding is stripped and the label becomes a free-floating text.
  containerId: z.string().nullable().optional(),
});

// API Routes

// Get all elements
app.get('/api/elements', (req: Request, res: Response) => {
  try {
    const elementsArray = Array.from(elementsFor(workspaceIdFrom(req)).values());
    res.json({
      success: true,
      elements: elementsArray,
      count: elementsArray.length
    });
  } catch (error) {
    logger.error('Error fetching elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Create new element
app.post('/api/elements', (req: Request, res: Response) => {
  try {
    const params = CreateElementSchema.parse(req.body);
    const workspaceId = workspaceIdFrom(req);
    const store = elementsFor(workspaceId);
    logger.info('Creating element via API', { type: params.type, workspace: workspaceId });

    // Prioritize passed ID (for MCP sync), otherwise generate new ID
    const id = params.id || generateId();
    const element: ServerElement = {
      id,
      ...params,
      fontFamily: normalizeFontFamily(params.fontFamily),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };

    // Resolve arrow bindings against existing elements
    if (element.type === 'arrow' || element.type === 'line') {
      resolveArrowBindings([element], store);
    }

    store.set(id, element);

    // Broadcast to all connected clients
    const message: ElementCreatedMessage = {
      type: 'element_created',
      element: element
    };
    broadcast(message, workspaceId);

    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error creating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Update element
app.put('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const updates = UpdateElementSchema.parse({ id, ...body });
    const workspaceId = workspaceIdFrom(req);
    const store = elementsFor(workspaceId);

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const existingElement = store.get(id);
    if (!existingElement) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    const updatedElement: ServerElement = {
      ...existingElement,
      ...updates,
      fontFamily: updates.fontFamily !== undefined ? normalizeFontFamily(updates.fontFamily) : existingElement.fontFamily,
      updatedAt: new Date().toISOString(),
      version: (existingElement.version || 0) + 1
    };

    // Keep Excalidraw text source in sync when clients update text via REST.
    // If originalText lags behind text, rendered wrapping/position can drift.
    const hasTextUpdate = Object.prototype.hasOwnProperty.call(body, 'text');
    const hasOriginalTextUpdate = Object.prototype.hasOwnProperty.call(body, 'originalText');
    if (updatedElement.type === EXCALIDRAW_ELEMENT_TYPES.TEXT && hasTextUpdate && !hasOriginalTextUpdate) {
      const incomingText = updates.text ?? '';
      const existingText = typeof existingElement.text === 'string' ? existingElement.text : '';
      const existingOriginalText = typeof existingElement.originalText === 'string'
        ? existingElement.originalText
        : '';
      const existingOriginalHasBr = /<\s*b\s*r\s*\/?\s*>/i.test(existingOriginalText);
      const normalizedExistingText = normalizeLineBreakMarkup(existingText);
      const normalizedExistingOriginalText = normalizeLineBreakMarkup(existingOriginalText);

      // Handle common cleanup flow: caller normalizes the rendered text value.
      // In this case, prefer normalized originalText so words aren't split by stale wraps.
      if (existingOriginalHasBr && incomingText === normalizedExistingText && normalizedExistingOriginalText) {
        updatedElement.text = normalizedExistingOriginalText;
        updatedElement.originalText = normalizedExistingOriginalText;
      } else {
        updatedElement.originalText = incomingText;
      }
    }

    store.set(id, updatedElement);

    // Broadcast to every client on this board except the one that asked for it. The author
    // already knows what it wrote, and the response below carries the whole element for it
    // to apply; what it does not need is the server's copy merged back over its live scene
    // a debounce behind (#190). Every other browser on the board has no other way to hear.
    const message: ElementUpdatedMessage = {
      type: 'element_updated',
      element: updatedElement
    };
    broadcast(message, workspaceId, clientIdFrom(req));

    // Moving/resizing a shape must drag its bound arrows along. Sent to the author too:
    // these are elements it did not write and does not otherwise know have moved.
    const geometryChanged = ['x', 'y', 'width', 'height']
      .some(key => Object.prototype.hasOwnProperty.call(body, key));
    if (geometryChanged && updatedElement.type !== 'arrow' && updatedElement.type !== 'line') {
      for (const arrow of rerouteBoundArrows(id, store)) {
        broadcast({ type: 'element_updated', element: arrow } as ElementUpdatedMessage, workspaceId);
      }
    }

    res.json({
      success: true,
      element: updatedElement
    });
  } catch (error) {
    logger.error('Error updating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Clear all elements (must be before /:id route)
app.delete('/api/elements/clear', (req: Request, res: Response) => {
  try {
    const workspaceId = workspaceIdFrom(req);
    const store = elementsFor(workspaceId);
    const count = store.size;
    store.clear();

    broadcast({
      type: 'canvas_cleared',
      timestamp: new Date().toISOString()
    }, workspaceId);

    logger.info(`Canvas cleared: ${count} elements removed`);

    res.json({
      success: true,
      message: `Cleared ${count} elements`,
      count
    });
  } catch (error) {
    logger.error('Error clearing canvas:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Delete element
app.delete('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const workspaceId = workspaceIdFrom(req);
    const store = elementsFor(workspaceId);
    if (!store.has(id)) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    store.delete(id);

    // Broadcast to all connected clients
    const message: ElementDeletedMessage = {
      type: 'element_deleted',
      elementId: id!
    };
    broadcast(message, workspaceId);

    res.json({
      success: true,
      message: `Element ${id} deleted successfully`
    });
  } catch (error) {
    logger.error('Error deleting element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Query elements with filters
app.get('/api/elements/search', (req: Request, res: Response) => {
  try {
    const { type, x_min, x_max, y_min, y_max, ...filters } = req.query;
    let results = Array.from(elementsFor(workspaceIdFrom(req)).values());

    // Filter by type if specified
    if (type && typeof type === 'string') {
      results = results.filter(element => element.type === type);
    }

    // Filter by bounding box if specified
    if (x_min !== undefined || x_max !== undefined || y_min !== undefined || y_max !== undefined) {
      const xMin = x_min !== undefined ? Number(x_min) : -Infinity;
      const xMax = x_max !== undefined ? Number(x_max) : Infinity;
      const yMin = y_min !== undefined ? Number(y_min) : -Infinity;
      const yMax = y_max !== undefined ? Number(y_max) : Infinity;

      results = results.filter(el =>
        el.x >= xMin &&
        el.x <= xMax &&
        el.y >= yMin &&
        el.y <= yMax
      );
    }

    // Apply additional exact-match filters
    if (Object.keys(filters).length > 0) {
      results = results.filter(element => {
        return Object.entries(filters).every(([key, value]) => {
          return (element as any)[key] === value;
        });
      });
    }

    res.json({
      success: true,
      elements: results,
      count: results.length
    });
  } catch (error) {
    logger.error('Error querying elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Get element by ID
app.get('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const element = elementsFor(workspaceIdFrom(req)).get(id);

    if (!element) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error fetching element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Helper: compute edge point for an element given a direction toward a target
function computeEdgePoint(
  el: ServerElement,
  targetCenterX: number,
  targetCenterY: number
): { x: number; y: number } {
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;

  if (el.type === 'diamond') {
    // Diamond edge: use diamond geometry (rotated square)
    const hw = (el.width || 0) / 2;
    const hh = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    // Scale factor to reach diamond edge
    const scale = (absDx / hw + absDy / hh) > 0
      ? 1 / (absDx / hw + absDy / hh)
      : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  if (el.type === 'ellipse') {
    // Ellipse edge: parametric intersection
    const a = (el.width || 0) / 2;
    const b = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + b };
    const angle = Math.atan2(dy, dx);
    return { x: cx + a * Math.cos(angle), y: cy + b * Math.sin(angle) };
  }

  // Rectangle: find intersection with edges
  const hw = (el.width || 0) / 2;
  const hh = (el.height || 0) / 2;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  // Check if ray intersects top/bottom edge or left/right edge
  if (Math.abs(tanA * hw) <= hh) {
    // Intersects left or right edge
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  } else {
    // Intersects top or bottom edge
    const signY = dy >= 0 ? 1 : -1;
    return { x: cx + signY * hh / tanA, y: cy + signY * hh };
  }
}

// Helper: resolve arrow bindings in a batch
function resolveArrowBindings(
  batchElements: ServerElement[],
  store: Map<string, ServerElement>
): void {
  const elementMap = new Map<string, ServerElement>();
  batchElements.forEach(el => elementMap.set(el.id, el));

  // Also check existing elements for cross-batch references
  store.forEach((el, id) => {
    if (!elementMap.has(id)) elementMap.set(id, el);
  });

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;

    if (!startRef && !endRef) continue;

    const startEl = startRef ? elementMap.get(startRef.id) : undefined;
    const endEl = endRef ? elementMap.get(endRef.id) : undefined;

    // Calculate arrow path from edge to edge
    const startCenter = startEl
      ? { x: startEl.x + (startEl.width || 0) / 2, y: startEl.y + (startEl.height || 0) / 2 }
      : { x: el.x, y: el.y };
    const endCenter = endEl
      ? { x: endEl.x + (endEl.width || 0) / 2, y: endEl.y + (endEl.height || 0) / 2 }
      : { x: el.x + 100, y: el.y };

    const GAP = 8;
    const startPt = startEl
      ? computeEdgePoint(startEl, endCenter.x, endCenter.y)
      : startCenter;
    const endPt = endEl
      ? computeEdgePoint(endEl, startCenter.x, startCenter.y)
      : endCenter;

    // Apply gap: move start point slightly away from source, end point slightly away from target
    const startDx = endPt.x - startPt.x;
    const startDy = endPt.y - startPt.y;
    const startDist = Math.sqrt(startDx * startDx + startDy * startDy) || 1;
    const endDx = startPt.x - endPt.x;
    const endDy = startPt.y - endPt.y;
    const endDist = Math.sqrt(endDx * endDx + endDy * endDy) || 1;

    const finalStart = {
      x: startPt.x + (startDx / startDist) * GAP,
      y: startPt.y + (startDy / startDist) * GAP
    };
    const finalEnd = {
      x: endPt.x + (endDx / endDist) * GAP,
      y: endPt.y + (endDy / endDist) * GAP
    };

    // Set arrow position and points
    el.x = finalStart.x;
    el.y = finalStart.y;
    el.points = [[0, 0], [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y]];

    // Do NOT delete `start` and `end` here.
    // Excalidraw's frontend `convertToExcalidrawElements` method looks for these exact properties
    // to calculate mathematically sound `startBinding`, `endBinding`, `focus`, `gap`, and `boundElements`.
  }
}

// After a shape's geometry changes, recompute every arrow bound to it so the
// visual connection follows the shape — bindings are otherwise only resolved
// at creation time, which left arrows floating at stale coordinates when
// update/align/distribute moved their endpoints. Returns the re-routed arrows.
function rerouteBoundArrows(
  movedId: string,
  store: Map<string, ServerElement>
): ServerElement[] {
  const rerouted: ServerElement[] = [];
  store.forEach(el => {
    if (el.type !== 'arrow' && el.type !== 'line') return;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;
    if (startRef?.id !== movedId && endRef?.id !== movedId) return;
    resolveArrowBindings([el], store);
    el.updatedAt = new Date().toISOString();
    el.version = (el.version || 0) + 1;
    rerouted.push(el);
  });
  return rerouted;
}

// Batch create elements
app.post('/api/elements/batch', (req: Request, res: Response) => {
  try {
    const { elements: elementsToCreate } = req.body;
    const batchWorkspaceId = workspaceIdFrom(req);
    const batchStore = elementsFor(batchWorkspaceId);

    if (!Array.isArray(elementsToCreate)) {
      return res.status(400).json({
        success: false,
        error: 'Expected an array of elements'
      });
    }

    const createdElements: ServerElement[] = [];

    elementsToCreate.forEach(elementData => {
      const params = CreateElementSchema.parse(elementData);
      // Prioritize passed ID (for MCP sync), otherwise generate new ID
      const id = params.id || generateId();
      const element: ServerElement = {
        id,
        ...params,
        fontFamily: normalizeFontFamily(params.fontFamily),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      };

      createdElements.push(element);
    });

    // Resolve arrow bindings (computes positions, startBinding, endBinding, boundElements)
    resolveArrowBindings(createdElements, batchStore);

    // Store all elements after binding resolution
    createdElements.forEach(el => batchStore.set(el.id, el));

    // Broadcast to all connected clients
    const message: BatchCreatedMessage = {
      type: 'elements_batch_created',
      elements: createdElements
    };
    broadcast(message, batchWorkspaceId);

    res.json({
      success: true,
      elements: createdElements,
      count: createdElements.length
    });
  } catch (error) {
    logger.error('Error batch creating elements:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Convert Mermaid diagram to Excalidraw elements
app.post('/api/elements/from-mermaid', (req: Request, res: Response) => {
  try {
    const { mermaidDiagram, config } = req.body;

    if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Mermaid diagram definition is required'
      });
    }

    logger.info('Received Mermaid conversion request', {
      diagramLength: mermaidDiagram.length,
      hasConfig: !!config
    });

    // Broadcast to all WebSocket clients to process the Mermaid diagram
    broadcast({
      type: 'mermaid_convert',
      mermaidDiagram,
      config: config || {},
      timestamp: new Date().toISOString()
    });

    // Return the diagram for frontend processing
    res.json({
      success: true,
      mermaidDiagram,
      config: config || {},
      message: 'Mermaid diagram sent to frontend for conversion.'
    });
  } catch (error) {
    logger.error('Error processing Mermaid diagram:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Sync elements from frontend (overwrite sync)
app.post('/api/elements/sync', (req: Request, res: Response) => {
  try {
    const { elements: frontendElements, timestamp } = req.body;

    logger.info(`Sync request received: ${frontendElements.length} elements`, {
      timestamp,
      elementCount: frontendElements.length
    });

    // Validate input data
    if (!Array.isArray(frontendElements)) {
      return res.status(400).json({
        success: false,
        error: 'Expected elements to be an array'
      });
    }

    // Record element count before sync
    const syncWorkspaceId = workspaceIdFrom(req);
    const store = elementsFor(syncWorkspaceId);
    const beforeCount = store.size;

    // Reconcile instead of clear-and-replace. A payload is what one client knows,
    // not the whole truth: an element the client never saw (created through the API
    // moments earlier) must survive. Absence means "no information", never "delete" —
    // deletions travel explicitly as isDeleted, the same contract Excalidraw uses
    // when reconciling collaborative scenes.
    let successCount = 0;
    let updatedCount = 0;
    let staleCount = 0;
    let deletedCount = 0;
    // Elements that won the race but arrived without what the server had written on them.
    // Logged because it is the only visible trace of a crossing, and #118 was invisible.
    let carriedCount = 0;
    const processedElements: ServerElement[] = [];

    frontendElements.forEach((element: any, index: number) => {
      try {
        // Ensure element has ID, generate one if missing
        const elementId = element.id || generateId();
        const existing = store.get(elementId);

        if (element.isDeleted) {
          // An explicit tombstone. Only honour it when it is newer than what we
          // hold, so a stale client cannot resurrect-then-delete a fresher edit.
          if (!existing) return;                       // already gone
          if (!isNewerVersion(element, existing)) { staleCount++; return; }
          store.delete(elementId);
          deletedCount++;
          return;
        }

        if (existing && !isNewerVersion(element, existing)) {
          // Our copy is newer — keep it and let the broadcast correct the client.
          staleCount++;
          processedElements.push(existing);
          return;
        }

        // Winning the version race does not win the whole element. `version` is the
        // browser's number — bumped on every keystroke and nudge, while the server bumps
        // it once per state change — so a payload that crosses a server write reverts it.
        // The fields the server authors are therefore taken out of the race entirely;
        // `element-authorship.ts` has the measurement behind that, and #118 is what it
        // cost. Everything else about the element is still the browser's.
        const authored = preserveServerAuthored(element as ServerElement, existing);
        if (existing && authored !== element) carriedCount++;

        // Add server metadata. Note version comes from the incoming element: it is
        // what makes the next reconciliation possible, so it must not be reset.
        const processedElement: ServerElement = {
          ...authored,
          id: elementId,
          syncedAt: new Date().toISOString(),
          source: 'frontend_sync',
          syncTimestamp: timestamp,
          version: typeof element.version === 'number' ? element.version : 1
        };

        // Store to memory
        store.set(elementId, processedElement);
        processedElements.push(processedElement);
        successCount++;
        if (existing) updatedCount++;

      } catch (elementError) {
        logger.warn(`Failed to process element ${index}:`, elementError);
      }
    });

    logger.info(
      `Sync reconciled: ${successCount} applied (${updatedCount} updates), ` +
      `${deletedCount} deleted, ${staleCount} ignored as stale, ` +
      `${carriedCount} kept their server-authored state, ${store.size} total`
    );

    // 3. Broadcast sync event to all WebSocket clients
    broadcast({
      type: 'elements_synced',
      count: successCount,
      timestamp: new Date().toISOString(),
      source: 'manual_sync'
    });

    // 4. Return sync results
    res.json({
      success: true,
      message: `Successfully synced ${successCount} elements`,
      count: successCount,
      updated: updatedCount,
      deleted: deletedCount,
      stale: staleCount,
      syncedAt: new Date().toISOString(),
      beforeCount,
      afterCount: store.size
    });

  } catch (error) {
    logger.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message,
      details: 'Internal server error during sync operation'
    });
  }
});

// ─── Workspaces API (one project per board) ───────────────────
//
// Loaded per request rather than cached at boot: a project's board.config.json gets
// edited while the server runs, and restarting to notice a config change would be silly.
app.get('/api/workspaces', async (_req: Request, res: Response) => {
  try {
    const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
    res.json({
      success: true,
      configured: Boolean(process.env.EXCALIDRAW_WORKSPACES),
      workspaces
    });
  } catch (error) {
    logger.error('Failed to load workspaces:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * The guard every route below shares.
 *
 * These write files this machine owns, and one of them lists its directories, so reaching
 * them from the network would be strictly worse than reaching the routes that only read a
 * project. Same shape as the issue block's guard, and for the same reason.
 */
function offLoopback(res: Response, what: string): boolean {
  if (LOOPBACK_ADDRESSES.includes(HOST) || HOST === 'localhost') return false;
  res.status(403).json({
    success: false,
    error: `${what} only while the server is bound to loopback.`
  });
  return true;
}

/**
 * Add a project to the registry.
 *
 * The registry is re-read per request, so an appended entry is live on the next call with
 * no restart — which is what makes a `+` on the tab strip cheap rather than a feature with
 * a server bounce in the middle of it.
 */
app.post('/api/workspaces', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Projects are added')) return;

  try {
    const result = await addWorkspace(process.env.EXCALIDRAW_WORKSPACES, {
      path: typeof req.body?.path === 'string' ? req.body.path : '',
      ...(typeof req.body?.id === 'string' ? { id: req.body.id } : {}),
      ...(typeof req.body?.distro === 'string' ? { distro: req.body.distro } : {})
    });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    logger.info(`Workspace "${result.workspace.id}" added at ${result.workspace.path}`);
    res.status(201).json({ success: true, workspace: result.workspace, workspaces: result.workspaces });
  } catch (error) {
    logger.error('Failed to add a workspace:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/**
 * The order the tabs are in.
 *
 * Above `/api/workspaces/:id/config` only for readability — the two cannot collide, one
 * being two segments after `/api/workspaces` and the other one. The whole list every time
 * rather than "move this one to position n": a permutation is checked against what the
 * registry holds in a single comparison, while an index is a guess about a list the caller
 * may have been looking at some seconds ago.
 */
app.put('/api/workspaces/order', async (req: Request, res: Response) => {
  if (offLoopback(res, 'The order of the projects is written')) return;

  try {
    const result = await reorderWorkspaces(process.env.EXCALIDRAW_WORKSPACES, req.body?.ids);
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    logger.info(`Workspace order set: ${result.workspaces.map((workspace) => workspace.id).join(', ')}`);
    res.json({ success: true, workspaces: result.workspaces });
  } catch (error) {
    logger.error('Failed to reorder the workspaces:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/** A project's config as it is on disk, which is what an editor has to start from. */
app.get('/api/workspaces/:id/config', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Project settings are read')) return;

  try {
    const result = await readWorkspaceConfig(process.env.EXCALIDRAW_WORKSPACES, req.params.id ?? '');
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    res.json({ success: true, config: result.config });
  } catch (error) {
    logger.error('Failed to read a workspace config:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.put('/api/workspaces/:id/config', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Project settings are saved')) return;

  try {
    const result = await writeWorkspaceConfig(
      process.env.EXCALIDRAW_WORKSPACES,
      req.params.id ?? '',
      req.body?.config
    );
    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    res.json({ success: true, workspace: result.workspace, workspaces: result.workspaces });
  } catch (error) {
    logger.error('Failed to write a workspace config:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

/** The project picker's other half — see `src/core/directory-browse.ts` for why. */
app.get('/api/fs/directories', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Directories are listed')) return;

  const asked = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    const listing = await listDirectories(asked);
    res.json({ success: true, ...listing });
  } catch (error) {
    res.status(400).json({ success: false, error: `Cannot list ${asked || 'the roots'}: ${(error as Error).message}` });
  }
});

// ─── Issue block ──────────────────────────────────────────────
//
// Turns an observation written on the board into a researched GitHub issue by running
// an agent inside the project. This is the most dangerous thing the server does: it
// spawns a process with full repository access on an API that has no authentication.
// Hence three guards — opt-in by env var, loopback only, and one run per element.
//
// Two commands rather than one, because a workspace may live in a WSL distro and a command
// is a path: the host's `claude.exe` is `No such file or directory` inside a distro, and the
// distro's `claude` is nowhere on the host. `agentCommandFor` picks per workspace and falls
// back to the native one, which is what keeps a command written without an absolute path
// working in both.
const ISSUE_AGENT_COMMANDS: AgentCommands = {
  native: process.env.EXCALIDRAW_ISSUE_AGENT || null,
  wsl: process.env.EXCALIDRAW_ISSUE_AGENT_WSL || null,
};

/** Whether any board at all may research. A workspace's own answer comes later. */
const ISSUE_AGENT_CONFIGURED = Boolean(ISSUE_AGENT_COMMANDS.native || ISSUE_AGENT_COMMANDS.wsl);

/**
 * The command a workspace's agent runs, or a refusal saying which variable would grant one.
 *
 * Per workspace rather than per server, because being enabled is now a fact about the pair:
 * a board with only `_WSL` set can research a distro-backed project and not a native one,
 * and the reverse. Naming the variable that is missing is the whole value of refusing here
 * rather than letting a run start and exit 127 somewhere the reader cannot see.
 */
function agentCommandRefusal(
  workspace: Workspace,
  commands: AgentCommands,
  what: string,
  variable: string
): string | null {
  if (agentCommandFor(workspace, commands)) return null;

  const where = workspace.environment.kind === 'wsl'
    ? { wanted: `${variable}_WSL or ${variable}`, names: `the WSL distro "${workspace.environment.distro}" names it` }
    : { wanted: variable, names: 'this machine names it' };
  return `${what} is not enabled for workspace "${workspace.id}". `
    + `Set ${where.wanted} to the agent command as ${where.names}.`;
}

/** The same answer, for the routes that write their own response. */
function agentCommandOrRefuse(
  res: Response,
  workspace: Workspace,
  commands: AgentCommands,
  what: string,
  variable: string
): string | null {
  const refusal = agentCommandRefusal(workspace, commands, what, variable);
  if (!refusal) return agentCommandFor(workspace, commands);
  res.status(404).json({ success: false, error: refusal });
  return null;
}

/**
 * What a block's research run has done, kept in memory beside the block that started it.
 *
 * This was a bare `Set<string>` — the guard that stops a second click opening a second issue,
 * and nothing else. A set can say *that* a run is in flight and never anything about it, which
 * is why a running block's panel had one fixed sentence to show for however long the
 * investigation took. It is a map now for the one fact that cannot go on the element: the
 * token totals change throughout a run, so writing them onto a shape would bump its `version`
 * and broadcast an update every time — the churn `docs/trap-export-noise.md` covers, arriving
 * through the other door. The two instants *do* go on the element, because they are written
 * once each and a block has to read correctly with nothing selected and no network.
 *
 * **The record outlives the run**, deliberately, the way `ImplementRecord` and `recreateRuns`
 * do. The panel's last read happens after the run settles — the ending arrives over the socket
 * as an element update, which carries the state and not the figures — so a record deleted at
 * the end would lose the total at exactly the moment it became worth reading. The reset route
 * is what clears one.
 */
interface IssueRunRecord {
  /** `running` until the run settles, then whichever state the block was left in. */
  state: 'running' | 'created' | 'failed';
  startedAt: string;
  /** Null while it is still going, which is what makes the clock live rather than a total. */
  endedAt: string | null;
  /**
   * What the run has spent, when the agent is willing to say.
   *
   * Null is the normal case and not a failure: it means the configured command does not ask
   * its agent for a machine-readable stream. See `src/core/agent-usage.ts`.
   */
  usage: AgentUsage | null;
}

/** The research runs, by element id. A second click must not open a second issue. */
const issueRuns = new Map<string, IssueRunRecord>();

/**
 * Whether a run is in flight *in this process*, which is what every guard here asks.
 *
 * Not "is there a record": a settled record is kept so the panel can read the total one last
 * time, and reading `has()` against this map would refuse a block a second run for the rest of
 * the server's life.
 */
const issueRunInFlight = (elementId: string): boolean =>
  issueRuns.get(elementId)?.state === 'running';

/**
 * Token counts onto the record, and nowhere else.
 *
 * The research-side twin of `recordImplementUsage`, and ignored once the run has settled for
 * the same reason: a report can still be in flight when the process closes, and it must not
 * resurrect a finished record.
 */
function recordIssueUsage(elementId: string, usage: AgentUsage): void {
  const existing = issueRuns.get(elementId);
  if (!existing || existing.state !== 'running') return;
  issueRuns.set(elementId, { ...existing, usage });
}

/**
 * Write the state onto a block, and the look that goes with it.
 *
 * Here rather than in the browser because this is where the state is authored: the
 * appearance then persists, exports and reaches every connected tab through the update
 * that already carries the state. A browser deriving it on render would have to derive it
 * again on every path that draws a block, and a block saved to `docs/board.excalidraw`
 * would go back to looking like a draft.
 *
 * At module level rather than inside the run, because the run is no longer the only writer:
 * a block that lost its state is put back with the same two writes, through
 * `applyIssueToBlock` below.
 */
function markIssueState(
  workspaceId: string,
  elementId: string,
  state: string,
  extra: Record<string, unknown> = {}
): void {
  const store = elementsFor(workspaceId);
  const current = store.get(elementId);
  if (!current) return;
  const updated: ServerElement = {
    ...current,
    ...issueBlockAppearance(state),
    customData: { ...(current.customData ?? {}), issueState: state, ...extra },
    updatedAt: new Date().toISOString(),
    version: (current.version || 0) + 1
  };
  store.set(elementId, updated);
  broadcast({ type: 'element_updated', element: updated } as ElementUpdatedMessage, workspaceId);
}

/**
 * Record on a block the issue it stands for: the state, the URL, the title, the look.
 *
 * Only the title is written onto `customData`, not the label alone: wrapping text to a box
 * and refitting the box needs font metrics, and the server has none. Writing the label here
 * produced a 518px title inside a 400px block, on one line, in a box still sized for the
 * observation. The browser owns geometry — it reads `issueTitle` and relays the block itself.
 *
 * The observation is kept rather than discarded: it is the wording that produced this
 * particular issue, and the panel still shows it.
 *
 * Best-effort by design where a run calls it: the issue is already created by the time this
 * runs, so a failure here must not turn a successful run into a failed block.
 */
async function applyIssueToBlock(
  workspace: Workspace,
  workspaceId: string,
  elementId: string,
  issueUrl: string,
  observation: string
): Promise<void> {
  const store = elementsFor(workspaceId);
  const detail = await fetchIssue(workspace, issueUrl);
  if (!detail.title) return;

  markIssueState(workspaceId, elementId, 'created', {
    issueUrl,
    issueError: null,
    issueTitle: detail.title,
    observation
  });

  const label = Array.from(store.values()).find(
    (candidate) => candidate.type === 'text'
      && (candidate as ServerElement & { containerId?: string }).containerId === elementId
  );
  const container = store.get(elementId);
  if (!label || !container) return;

  // Lay the title out rather than just writing it. Excalidraw wraps bound text and
  // refits its container in redrawTextBoundingBox, which runs on its own edit paths —
  // never on an element that arrives from outside. Writing the text alone left a title
  // wider than its box, on one line, in a box still sized for the observation.
  // Excalidraw draws bound text at 20 when the element carries no size of its own, and
  // laying the title out for 16 produced a box too short for the text and a wrap that
  // came too late. The size is written back below rather than merely assumed, so the
  // browser and this calculation use the same number by construction — matching a
  // default this code does not own would only hold until that default moved.
  const fontSize = typeof label.fontSize === 'number' ? label.fontSize : DEFAULT_BOUND_TEXT_FONT_SIZE;
  const containerWidth = typeof container.width === 'number' ? container.width : 400;
  const laid = layoutLabel(detail.title, containerWidth, fontSize);

  const containerHeight = Math.max(laid.containerHeight, fontSize * 2);
  const updatedContainer: ServerElement = {
    ...container,
    height: containerHeight,
    updatedAt: new Date().toISOString(),
    version: (container.version || 0) + 1
  };
  store.set(elementId, updatedContainer);
  broadcast({ type: 'element_updated', element: updatedContainer } as ElementUpdatedMessage, workspaceId);

  const updatedLabel: ServerElement = {
    ...label,
    text: laid.text,
    fontSize,
    width: laid.width,
    height: laid.height,
    // Centred in the container, the way Excalidraw centres bound text itself.
    x: (updatedContainer.x ?? 0) + (containerWidth - laid.width) / 2,
    y: (updatedContainer.y ?? 0) + (containerHeight - laid.height) / 2,
    updatedAt: new Date().toISOString(),
    version: (label.version || 0) + 1
  };
  store.set(updatedLabel.id, updatedLabel);
  broadcast({ type: 'element_updated', element: updatedLabel } as ElementUpdatedMessage, workspaceId);
}

app.post('/api/issue-block/:id', async (req: Request, res: Response) => {
  const elementId = req.params.id ?? '';

  if (!ISSUE_AGENT_CONFIGURED) {
    return res.status(404).json({
      success: false,
      error: 'Issue blocks are disabled. Set EXCALIDRAW_ISSUE_AGENT to the agent command to enable them.'
    });
  }

  // Running an agent is remote code execution for anyone who can reach this port.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'Issue blocks only run while the server is bound to loopback.'
    });
  }

  const workspaceId = workspaceIdFrom(req);
  const store = elementsFor(workspaceId);
  const element = store.get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  if (custom.issueUrl) {
    return res.status(409).json({
      success: false,
      error: 'This block already has an issue.',
      issueUrl: custom.issueUrl
    });
  }
  if (issueRunInFlight(elementId)) {
    return res.status(409).json({ success: false, error: 'A run is already in flight for this block.' });
  }

  // A shape's label is a separate element bound to it, so reading element.text alone
  // would find nothing for the normal way of writing inside a box.
  const boundText = Array.from(store.values()).find(
    (candidate) => candidate.type === 'text' &&
      (candidate as ServerElement & { containerId?: string }).containerId === elementId
  );
  const observation = typeof req.body?.observation === 'string' && req.body.observation.trim()
    ? req.body.observation.trim()
    : [element.text, boundText?.text]
        .find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
  if (!observation) {
    return res.status(400).json({ success: false, error: 'The block has no observation to work from.' });
  }

  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return res.status(400).json({
      success: false,
      error: `Workspace "${workspaceId}" is not registered, so there is no project to run in.`
    });
  }
  if (workspace.error) {
    return res.status(400).json({ success: false, error: `Workspace is unusable: ${workspace.error}` });
  }

  const agentCommand = agentCommandOrRefuse(
    res, workspace, ISSUE_AGENT_COMMANDS, 'Researching', 'EXCALIDRAW_ISSUE_AGENT'
  );
  if (!agentCommand) return;

  const startedAt = new Date().toISOString();
  issueRuns.set(elementId, { state: 'running', startedAt, endedAt: null, usage: null });
  const markState = (state: string, extra: Record<string, unknown> = {}) =>
    markIssueState(workspaceId, elementId, state, extra);

  /**
   * The end of the run, written to the record and the block in one place.
   *
   * One function rather than an `issueEndedAt` beside each of the three `markState` calls
   * below, because the ending is what the clock is subtracting against: a path that settled a
   * block and forgot the instant would leave a total ticking forever, and that is precisely
   * the failure a reader cannot see. `issueStartedAt` needs no carrying — `markIssueState`
   * merges onto the `customData` already there.
   */
  const settle = (state: 'created' | 'failed', extra: Record<string, unknown> = {}): void => {
    const endedAt = new Date().toISOString();
    const existing = issueRuns.get(elementId);
    if (existing) issueRuns.set(elementId, { ...existing, state, endedAt });
    markState(state, { ...extra, issueEndedAt: endedAt });
  };

  // Two instants, not a duration: a duration kept here would have to be rewritten to stay
  // true, and every rewrite bumps the element's `version` and broadcasts it. The browser
  // subtracts instead, and the board never knows the clock is running.
  markState('running', { issueStartedAt: startedAt, issueEndedAt: null });
  // Answer immediately: an investigation takes minutes, and a request held open that
  // long looks indistinguishable from a hang. Progress arrives over the socket.
  res.status(202).json({ success: true, state: 'running', elementId });

  let images: MaterializedImages = NO_IMAGES;
  try {
    // The images are written before the spawn and removed in the `finally` below, on the
    // failure path as much as on the success one — they exist only while the run does.
    // A failure to write them is not a failure of the run: the observation is still worth
    // investigating, and an image is not worth the investigation.
    try {
      images = await materializeIssueImages(
        workspace,
        issueImageIds(element.customData),
        (fileId) => files.get(fileId),
        elementId
      );
    } catch (error) {
      logger.warn(`Issue block ${elementId}: could not prepare reference images — ${(error as Error).message}`);
    }

    const result = await runIssueAgent(workspace, observation, {
      agentCommand,
      imagePaths: images.paths,
      notFoundVariable: 'EXCALIDRAW_ISSUE_AGENT_WSL',
      onUsage: (usage) => recordIssueUsage(elementId, usage)
    });
    if (result.ok && result.issueUrl) {
      settle('created', { issueUrl: result.issueUrl, issueError: null, observation });
      logger.info(`Issue block ${elementId} created ${result.issueUrl}`);

      // The issue exists now, so it no longer belongs where the observation was written —
      // the notes column, which the canvas draws for itself and which no project item can
      // be in. The issue the agent created is on the project, in whichever column its
      // *Item added to project* workflow put it; that decision is made outside this
      // repository and cannot be read back, so this move is what makes the landing column
      // something we know rather than something we hope for.
      //
      // Deliberately not awaited and never fatal, exactly as for the In Progress move: the
      // issue is already created by the time this runs, and a `gh` working through its
      // retries must not hold the block in `running`. A failed board write costs a log line.
      // A run that created *no* issue reaches the branch below instead and moves nothing —
      // there is nothing to move, and the draft is deliberately kept.
      void moveIssueToColumn(workspace, result.issueUrl, todoColumn(workspace))
        .then((column) => { if (column) logger.info(`${result.issueUrl} was researched, so its card moved to "${column}"`); })
        .catch((error) => logger.warn(
          `Could not move ${result.issueUrl} on the project board: ${(error as Error).message}`
        ));

      try {
        await applyIssueToBlock(workspace, workspaceId, elementId, result.issueUrl, observation);
      } catch (error) {
        logger.warn(`Issue block ${elementId}: could not read back the issue — ${(error as Error).message}`);
      }
    } else {
      settle('failed', { issueError: result.error });
      logger.warn(`Issue block ${elementId} failed: ${result.error}`);
    }
  } catch (error) {
    settle('failed', { issueError: (error as Error).message });
  } finally {
    await images.cleanup();
  }
});

/**
 * What a block's research run has done so far, with no `gh` behind it.
 *
 * Its own route rather than an extension of `GET /api/issue-block/:id/issue`, which is the
 * question the panel is *not* asking here: that one reads the issue from GitHub and answers 404
 * for a block that has none — which is every block with a run in flight. This reads memory and
 * costs nothing, so the panel can poll it while a run is live the way it polls the implement
 * record.
 *
 * The clock is deliberately not the reason to call it. Both instants are on the element, so a
 * block already reads correctly with nothing selected and no network; what only lives here is
 * the token total, because a figure that changes throughout a run cannot go on a shape without
 * broadcasting an update every time it does.
 */
app.get('/api/issue-block/:id/run', (req: Request, res: Response) => {
  res.json({ success: true, run: issueRuns.get(req.params.id ?? '') ?? null });
});

/**
 * Tell a block which issue it already produced.
 *
 * The way back from #118. A block whose state was overwritten by a browser sync carries no
 * `issueState` and no `issueUrl`, and nothing else in this file can touch it: `DELETE`
 * resets a `running` block and this one is not running, and `POST` would start a **second**
 * research run for an issue that already exists, because the guard that refuses one reads
 * `issueUrl`. Deleting the block by hand was the only answer, and it throws away the
 * observation with it.
 *
 * So the block is told the answer instead. It is the same two writes the end of a successful
 * run makes — `applyIssueToBlock` — and therefore leaves a block indistinguishable from one
 * whose run was recorded properly: `reconcileDrafts` can retire it, the panel renders the
 * issue, and `POST` refuses it a second run.
 *
 * **It does not create anything.** The URL names an issue that already exists; the route
 * reads it and refuses if `gh` cannot. That is what keeps this from being a way to write an
 * arbitrary URL onto a block and have the board believe it.
 *
 * Guarded like the read route rather than like the run route: it starts no agent and touches
 * no repository, but it does shell out to `gh` holding your credentials, so loopback only.
 */
app.post('/api/issue-block/:id/adopt', async (req: Request, res: Response) => {
  if (offLoopback(res, 'Adopting an issue')) return;

  const elementId = req.params.id ?? '';
  const workspaceId = workspaceIdFrom(req);
  const store = elementsFor(workspaceId);
  const element = store.get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  if (custom.kind !== 'issue') {
    return res.status(400).json({ success: false, error: 'That shape is not an issue block.' });
  }
  // A block that already knows its issue has nothing to adopt, and quietly pointing one at a
  // different issue would lose the first without saying so.
  if (custom.issueUrl) {
    return res.status(409).json({
      success: false,
      error: 'This block already has an issue.',
      issueUrl: custom.issueUrl
    });
  }
  if (issueRunInFlight(elementId)) {
    return res.status(409).json({
      success: false,
      error: 'A run is in flight for this block right now. Wait for it rather than guessing its answer.'
    });
  }

  const issueUrl = typeof req.body?.issueUrl === 'string' ? req.body.issueUrl.trim() : '';
  if (!isIssueUrl(issueUrl)) {
    return res.status(400).json({
      success: false,
      error: 'Expected the URL of a GitHub issue, like https://github.com/owner/repo/issues/1.'
    });
  }

  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return res.status(400).json({
      success: false,
      error: `Workspace "${workspaceId}" is not registered, so there is no project to read the issue in.`
    });
  }

  // The observation is whatever the block still says, the way the run reads it — the text is
  // about to be replaced by the issue's title, so this is the last moment it can be kept.
  const boundText = Array.from(store.values()).find(
    (candidate) => candidate.type === 'text' &&
      (candidate as ServerElement & { containerId?: string }).containerId === elementId
  );
  const observation = typeof custom.observation === 'string' && custom.observation.trim()
    ? custom.observation.trim()
    : [element.text, boundText?.text]
        .find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';

  try {
    await applyIssueToBlock(workspace, workspaceId, elementId, issueUrl, observation);
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: `Could not read ${issueUrl}: ${(error as Error).message}`
    });
  }

  const adopted = (store.get(elementId)?.customData ?? {}) as Record<string, unknown>;
  if (!adopted.issueUrl) {
    // `applyIssueToBlock` writes nothing for an issue with no title, which is what a `gh`
    // that answered about something else looks like. Saying so beats a silent 200.
    return res.status(502).json({
      success: false,
      error: `${issueUrl} came back without a title, so nothing was written onto the block.`
    });
  }
  res.json({ success: true, issueUrl, issueTitle: adopted.issueTitle ?? null, elementId });
});

/**
 * Clear a stuck `running` state so the block can be tried again.
 *
 * A run has no ceiling any more, so nothing kills a wedged agent and nothing else ever
 * clears that state — and a block left in it is dead: the panel hides the create control
 * there. This is the way back, and the implement path's opposite number (`DELETE
 * .../implement`), for the same reason and with the same honesty about what it does.
 *
 * It clears state; it does not stop an agent. Nothing here can reach into a process the
 * server no longer owns. What it can do is refuse while a run is in flight *in this
 * process*, which is the case that matters: `issueRuns` is in memory, so after a
 * restart it is empty while the element still carries `running` from browser sync — only
 * the server can tell a live run from an abandoned one.
 *
 * The issue itself is untouched, which is what stops a reset becoming a second issue for
 * one observation: `POST` guards on `customData.issueUrl`, and that stays.
 */
app.delete('/api/issue-block/:id', (req: Request, res: Response) => {
  const elementId = req.params.id ?? '';
  const workspaceId = workspaceIdFrom(req);
  const store = elementsFor(workspaceId);
  const element = store.get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  if (issueRunInFlight(elementId)) {
    return res.status(409).json({
      success: false,
      error: 'A run is in flight for this block right now. Resetting would only hide it.'
    });
  }

  // The run is being declared lost, so what it claimed about itself goes with the state: a
  // block left carrying the instants would keep showing a clock for a run nobody is waiting
  // for, and the record behind it would keep answering the panel's poll.
  issueRuns.delete(elementId);
  const {
    issueState, issueError, issueStartedAt, issueEndedAt, ...rest
  } = (element.customData ?? {}) as Record<string, unknown>;
  const resetTo = rest.issueUrl ? 'created' : 'draft';
  const updated: ServerElement = {
    ...element,
    // The look goes back with the state. This route is the other writer of `issueState`,
    // so a block reset here would otherwise keep whatever the stuck run had painted on it.
    ...issueBlockAppearance(resetTo),
    // A block that already produced an issue is `created`, whatever the stuck state said.
    // Dropping the state outright would send that card back to offering a run the POST
    // route would then refuse.
    customData: rest.issueUrl ? { ...rest, issueState: 'created' } : rest,
    updatedAt: new Date().toISOString(),
    version: (element.version || 0) + 1
  };
  store.set(elementId, updated);
  broadcast({ type: 'element_updated', element: updated } as ElementUpdatedMessage, workspaceId);

  logger.info(`Issue block ${elementId} reset from "${issueState ?? 'no state'}"`
    + `${issueError ? ', and its error cleared' : ''}`);
  res.json({ success: true, elementId });
});

/**
 * Issues read recently enough to hand back without spawning another `gh`.
 *
 * Selecting a block used to cost a whole `gh issue view`, every time, for text that had not
 * changed — and the panel drew its controls from "not read yet" for the whole of that
 * second. The panel remembers what it read too; this is the half that means a burst of
 * clicks, or two tabs open on one board, still only asks GitHub once.
 *
 * Only the issue is memoised. The implement record is read fresh on every request, because
 * it costs nothing to read and is the fact most likely to have changed since.
 */
const issueMemo = new IssueMemo<IssueDetail>(memoWindow(process.env.EXCALIDRAW_ISSUE_MEMO_MS));

// ─── Implementing an issue ────────────────────────────────────
//
// The issue block's opposite number, and its opposite in permissions. The issue agent is
// deliberately powerless — gh, git and reading, nothing that writes. An agent that
// implements has to write code, so it gets its own command and its own opt-in: enabling
// issue blocks must not quietly enable repository writes. That separation is why the WSL
// half is a pair rather than one variable: a board that granted a distro an agent for
// research must not thereby have granted it one that writes.
const IMPLEMENT_AGENT_COMMANDS: AgentCommands = {
  native: process.env.EXCALIDRAW_IMPLEMENT_AGENT || null,
  wsl: process.env.EXCALIDRAW_IMPLEMENT_AGENT_WSL || null,
};

/** Whether any board at all may implement. A workspace's own answer comes later. */
const IMPLEMENT_AGENT_CONFIGURED = Boolean(
  IMPLEMENT_AGENT_COMMANDS.native || IMPLEMENT_AGENT_COMMANDS.wsl
);

/**
 * How many implementations one workspace may have in flight at once.
 *
 * It used to be unlimited, and unlimited by accident: nothing counted runs, because the
 * only guard was per issue. Now that each run has a checkout of its own, several at once
 * are safe rather than merely tolerated — so the default is a number greater than one, and
 * a small one, because every run is a whole coding agent building and testing on this
 * machine. `0` means no cap; `1` serialises.
 */
const IMPLEMENT_CONCURRENCY = (() => {
  const configured = process.env.EXCALIDRAW_IMPLEMENT_CONCURRENCY;
  if (configured === undefined || configured.trim() === '') return 4;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 4;
})();

/**
 * Write an implementation's state everywhere it is shown.
 *
 * The record against the issue URL is the truth. The copy on the elements is a convenience
 * with one job: a block has to read correctly with nothing selected and with no network,
 * which is the same reason the issue title is kept on the element. Every element carrying
 * this issue gets the copy, so an authored block and a mirrored card cannot disagree.
 *
 * `null` clears rather than writes, which is what the reset does.
 *
 * The two instants travel with the state and the token counts deliberately do not. Every
 * write here bumps a `version` on every element carrying the issue and broadcasts it,
 * which is the bookkeeping that makes exports churn — so what goes on an element has to be
 * something that changes when the state does and not otherwise. `startedAt` and `endedAt`
 * are written once each; a browser holding either of them can run a clock off it without
 * asking anyone. Usage changes throughout a run, so it stays on the record alone.
 */
function recordImplement(
  workspaceId: string,
  issueUrl: string,
  record: ImplementRecord | null
): void {
  if (record) writeImplement(workspaceId, issueUrl, record);
  else clearImplement(workspaceId, issueUrl);

  // A run is the one thing the board does that changes the issue on GitHub: it ends in a
  // pull request, and a pull request is what closes it. So whatever was remembered about
  // the issue is dropped here rather than waited out — the panel's next selection is where
  // "closed by #N" has to appear, and it must not be answered from before the run.
  issueMemo.forget(workspaceId, issueUrl);

  const store = elementsFor(workspaceId);
  for (const [id, element] of store) {
    const custom = (element.customData ?? {}) as Record<string, unknown>;
    if (custom.issueUrl !== issueUrl) continue;

    const {
      implementState, implementUrl, implementError, implementStartedAt, implementEndedAt, ...rest
    } = custom;
    const updated: ServerElement = {
      ...element,
      customData: record
        ? {
            ...rest,
            implementState: record.state,
            implementUrl: record.url,
            implementError: record.error,
            implementStartedAt: record.startedAt,
            implementEndedAt: record.endedAt
          }
        : rest,
      updatedAt: new Date().toISOString(),
      version: (element.version || 0) + 1
    };
    store.set(id, updated);
    broadcast({ type: 'element_updated', element: updated } as ElementUpdatedMessage, workspaceId);
  }
}

/**
 * What a run has accumulated so far, to carry into the record that replaces this one.
 *
 * `recordImplement` takes a whole record, and a run writes three or four of them: running,
 * running-with-a-worktree, then done or failed. Rebuilding each from literals is how the
 * start time would quietly be lost halfway through — so it is read back rather than
 * remembered.
 */
function carriedImplement(
  workspaceId: string,
  issueUrl: string
): Pick<ImplementRecord, 'startedAt' | 'usage' | 'terminal'> {
  const existing = readImplement(workspaceId, issueUrl);
  return {
    startedAt: existing?.startedAt ?? null,
    usage: existing?.usage ?? null,
    // Carried for the same reason the start time is: the session is opened once, in the
    // middle of the run, and a record rebuilt from literals at the end would forget which
    // tab the run happened in exactly when somebody goes looking for its transcript.
    terminal: existing?.terminal ?? null,
  };
}

/**
 * Token counts onto the record, and nowhere else.
 *
 * Deliberately not `recordImplement`: these arrive throughout a run, and writing each one
 * onto every element carrying the issue would bump a version and broadcast an update every
 * time — the churn the clock is careful to avoid, arriving through the other door. The
 * panel polls the record every four seconds and picks them up there, and a block with
 * nothing selected has no use for them.
 *
 * Ignored once the run has settled: a report can still be in flight when the process
 * closes, and it must not resurrect a finished record.
 */
function recordImplementUsage(
  workspaceId: string,
  issueUrl: string,
  usage: ImplementUsage
): void {
  const existing = readImplement(workspaceId, issueUrl);
  if (!existing || existing.state !== 'running') return;
  writeImplement(workspaceId, issueUrl, { ...existing, usage });
}

/**
 * The session a run was given, onto the record and nowhere else.
 *
 * The same reasoning as `recordImplementUsage`, and the same door: this arrives in the
 * middle of a run, and `recordImplement` would write it onto every element carrying the
 * issue — a version bump and a broadcast each — for a fact a block with nothing selected
 * cannot show. The panel reads the record, and the tab is on the canvas already.
 *
 * Ignored once the run has settled, so a session announced late cannot resurrect a finished
 * record.
 */
function recordImplementTerminal(
  workspaceId: string,
  issueUrl: string,
  terminal: string
): void {
  const existing = readImplement(workspaceId, issueUrl);
  if (!existing || existing.state !== 'running') return;
  writeImplement(workspaceId, issueUrl, { ...existing, terminal });
}

/**
 * What a request to start a run is answered with.
 *
 * The answer is a value rather than a response written in place, because the routes are no
 * longer the only caller: the queue starts runs through this same function and has no
 * request to answer — what it needs is the *status*, since `409` is precisely how it is told
 * the cap is full and to come back later. A second entrance that skipped these guards would
 * be a second way for one issue to become two pull requests.
 */
interface ImplementAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Start an implementation for one issue, however it was asked for.
 *
 * Both routes land here — the element one for an authored block, the URL one for a mirrored
 * card that has no element at all — and so does the queue, so the guards are stated once and
 * cannot drift apart. It returns as soon as the run is under way rather than when the run
 * ends: implementing has no time limit, so a held-open request would only look like a hang.
 *
 * `resume` is the same run with one thing added to the prompt, and one guard added in front of
 * it. Not a route of its own: everything below — the per-issue guard, the cap, the worktree,
 * the release — is identical, and a second copy of it would be a second place for the guard
 * that stops one issue becoming two pull requests to be got wrong.
 */
async function beginImplement(
  workspaceId: string,
  issueUrl: string,
  options: { resume?: boolean; interactive?: boolean } = {}
): Promise<ImplementAnswer> {
  if (!isIssueUrl(issueUrl)) {
    return { status: 400, body: { success: false, error: `Not a GitHub issue URL: ${issueUrl}` } };
  }

  const existing = readImplement(workspaceId, issueUrl);
  if (existing?.state === 'running') {
    return {
      status: 409,
      body: { success: false, error: 'An implementation is already in flight for this issue.' }
    };
  }
  // Resuming is a claim about the past — that there is an attempt to continue — so it is
  // refused when the server does not agree there was one. A resume that quietly became a
  // fresh run would be the exact failure this feature exists to stop, arriving through the
  // button that was meant to prevent it.
  if (options.resume && existing?.state !== 'interrupted') {
    return {
      status: 409,
      body: {
        success: false,
        error: existing
          ? `There is no interrupted run to resume for this issue; it is ${existing.state}.`
          : 'There is no interrupted run to resume for this issue.'
      }
    };
  }
  if (existing?.state === 'done' && existing.url) {
    // The same reasoning that stops one observation becoming two issues.
    return {
      status: 409,
      body: {
        success: false,
        error: 'This issue already has an implementation.',
        implementUrl: existing.url
      }
    };
  }

  // Before the slot is claimed, because this refusal has nothing to undo: the board either
  // has an interactive tab to give or it has not, and neither answer depends on the run.
  const interactiveRefusal = options.interactive ? await interactiveTabRefusal(workspaceId) : null;
  if (interactiveRefusal) {
    return { status: 409, body: { success: false, error: interactiveRefusal } };
  }

  // A board that can start runs faster than a machine can finish them needs a budget, and a
  // refusal has to say which run is holding the slot to be worth reading. It is not only a
  // budget: a cap that leaks puts two `git worktree add` in the same instant, and they
  // collide on the shared `.git/config`.
  const inFlight = runningImplements(workspaceId);
  if (IMPLEMENT_CONCURRENCY > 0 && inFlight.length >= IMPLEMENT_CONCURRENCY) {
    return {
      status: 409,
      body: {
        success: false,
        error: `This workspace already has ${inFlight.length} implementation(s) running, which is the limit `
          + `set by EXCALIDRAW_IMPLEMENT_CONCURRENCY. In flight: ${inFlight.map((run) => run.issueUrl).join(', ')}`,
        running: inFlight.map((run) => run.issueUrl)
      }
    };
  }

  // The slot is claimed here, before the first `await`, and that placement is the whole
  // guard. Counting and claiming have to be one uninterrupted step: while this write sat
  // below the registry read, two clicks arriving together both counted before either
  // claimed, both passed, and the cap was exceeded by however many fitted in the window.
  // Nothing between the count above and this line yields, so there is no window left.
  //
  // This is also the one write of the start time. Everything after it carries this instant
  // forward, and everything showing a duration subtracts from it rather than being told one.
  recordImplement(workspaceId, issueUrl, {
    state: 'running',
    url: null,
    error: null,
    worktree: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    usage: null,
    terminal: null
  });

  /**
   * Give the slot back, for a run refused after it was claimed.
   *
   * The cost of claiming first is that the refusals below now have something to undo, and a
   * slot held by a run that never started would shrink the cap until the server restarts —
   * the same defect pointing the other way. What was there before the claim is put back
   * rather than cleared, so a previous failure's error survives an attempt that got no
   * further than the registry.
   */
  const releaseSlot = (): void => recordImplement(workspaceId, issueUrl, existing);

  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    releaseSlot();
    return {
      status: 400,
      body: {
        success: false,
        error: `Workspace "${workspaceId}" is not registered, so there is no project to work in.`
      }
    };
  }
  if (workspace.error) {
    releaseSlot();
    return {
      status: 400,
      body: { success: false, error: `Workspace is unusable: ${workspace.error}` }
    };
  }

  // After the claim, so it goes through `releaseSlot` like every other late refusal: a
  // workspace whose environment was never granted a command must not hold a slot for it.
  const agentRefusal = agentCommandRefusal(
    workspace, IMPLEMENT_AGENT_COMMANDS, 'Implementing', 'EXCALIDRAW_IMPLEMENT_AGENT'
  );
  if (agentRefusal) {
    releaseSlot();
    return { status: 404, body: { success: false, error: agentRefusal } };
  }

  // Not awaited: the run outlives the answer, which is the whole reason the answer is 202.
  // Its failures are recorded against the issue rather than thrown at whoever asked.
  void runImplementation(workspace, issueUrl, options);
  return { status: 202, body: { success: true, state: 'running', issueUrl } };
}

/**
 * Why this board cannot give a run an interactive tab, or null when it can.
 *
 * **This is the one place a missing tab stops a run**, and it is deliberate. Everywhere else
 * a tab is offered and never required — `implementTerminalHost` returns null and the run
 * happens in a private child exactly as it did before the terminal existed, because a 409
 * from the cap must never be what stops an implementation from starting. Here the reader
 * asked for the tab. Falling back would hand them a run with its print flags removed and no
 * interface to draw with them: no screen, no token counts, and nothing to type into — worse
 * than the run they would have got by not asking. A refusal that says which of the three is
 * missing is the honest answer, and the click that produced it can simply be made again
 * without the ask.
 *
 * A 409 rather than a 400, like the cap: a conflict with what this board *is*, not a request
 * that was malformed.
 */
/**
 * The command line this run is spawned with, which is the operator's unless the reader asked.
 *
 * Named rather than written inline so the "unless" is one expression: a run nobody asked
 * anything about must spawn the string in `EXCALIDRAW_IMPLEMENT_AGENT` byte for byte, and
 * that is the rule every other feature that touches this command already keeps.
 */
function interactiveCommand(agentCommand: string, interactive?: boolean): string {
  return interactive ? withoutPrintFlags(agentCommand) : agentCommand;
}

async function interactiveTabRefusal(workspaceId: string): Promise<string | null> {
  if (!terminalAvailable()) {
    return 'An interactive run needs a terminal tab to run in, and the terminal is off on '
      + 'this board. Set EXCALIDRAW_TERMINAL to turn it on, or start the run without asking '
      + 'for a tab to answer.';
  }
  if (!await loadPty()) {
    return 'An interactive run needs a pseudoterminal, and this board has none — either no '
      + '@lydell/node-pty binary for this platform, or EXCALIDRAW_TERMINAL_PTY=0. On pipes '
      + 'there is no interface to draw and nothing to type into, so the terminal tab would '
      + 'be the same read-only screen an ordinary run gets.';
  }
  if (terminalSessionsFor(workspaceId).size >= TERMINAL_SESSION_LIMIT) {
    return `An interactive run needs one of this board's ${TERMINAL_SESSION_LIMIT} terminal `
      + 'tabs, and all of them are in use. Close one first, or start the run without asking '
      + 'for a tab to answer.';
  }
  return null;
}

/**
 * The run itself, once the slot is claimed and the workspace is known to be usable.
 *
 * Split from the guards above so that starting a run and *answering* a request are two
 * things: the queue does the first without the second. Everything here is written to the
 * record against the issue, which is where a click, a card and a queue pass all read it.
 */
async function runImplementation(
  workspace: Workspace,
  issueUrl: string,
  options: { resume?: boolean; interactive?: boolean } = {}
): Promise<void> {
  const workspaceId = workspace.id;

  // The board says Todo until something says otherwise, and starting the run is the
  // something. Deliberately not awaited: the project and the agent are independent, and a
  // `gh` working through its retries must not hold an implementation up. Deliberately not
  // fatal either — a board write that fails costs a log line and nothing else, because the
  // point of the run is the pull request, not the column.
  void moveIssueToColumn(workspace, issueUrl, inProgressColumn(workspace))
    .then((column) => { if (column) logger.info(`${issueUrl} is being implemented, so its card moved to "${column}"`); })
    .catch((error) => logger.warn(
      `Could not move ${issueUrl} on the project board: ${(error as Error).message}`
    ));

  let worktree: ImplementWorktree | null = null;
  try {
    worktree = await ensureWorktree(workspace, issueUrl);
    if (worktree) {
      recordImplement(workspaceId, issueUrl, {
        state: 'running', url: null, error: null, worktree: worktree.path, endedAt: null,
        ...carriedImplement(workspaceId, issueUrl)
      });
    }

    // Read here rather than remembered from the record: the record says a run was interrupted,
    // the worktree says what is actually in it, and the second is what the agent is about to
    // be looking at. Nothing has touched the checkout between the guard above and this line,
    // and `ensureWorktree` reuses it rather than rebuilding it.
    const resuming = options.resume
      ? (await interruptedRuns(workspace)).find((run) => run.issueUrl === issueUrl)?.worktree ?? null
      : null;

    // Offered, never required. With no terminal on this board — or with its tabs all taken —
    // this is null and the run happens in a private child, which is the only thing it could
    // do before the two features knew about each other.
    const host = implementTerminalHost(workspace, issueUrl);

    const result = await runImplementAgent(workspace, issueUrl, {
      // Resolved here rather than handed down: `beginImplement` has already refused a
      // workspace with no command for its environment, so by this line there is one.
      //
      // And this is the whole of what a per-run "interactive" changes. Everything downstream
      // already reads the shape of the command rather than a second setting — `runsHeadless`
      // decides whether the tab gets a pseudoterminal, `buildAgentCommand` decides whether
      // the prompt goes to stdin or travels as the last argument, `streamsUsage` decides
      // whether there are token counts to read — so taking the print flags off is the same
      // request the operator makes by leaving them out of `EXCALIDRAW_IMPLEMENT_AGENT`, made
      // once instead of forever. `withoutPrintFlags` only ever removes; a command with no
      // print flags in it comes back byte for byte.
      agentCommand: interactiveCommand(
        agentCommandFor(workspace, IMPLEMENT_AGENT_COMMANDS) as string, options.interactive
      ),
      notFoundVariable: 'EXCALIDRAW_IMPLEMENT_AGENT_WSL',
      worktree,
      resuming,
      // Reached only when the configured command already streams. Otherwise the agent
      // prints prose at exit, there is nothing to read, and this is never called.
      onUsage: (usage) => recordImplementUsage(workspaceId, issueUrl, usage),
      ...(host ? { host } : {})
    });
    const kept = await releaseWorktreeFor(workspace, worktree, issueUrl);

    if (result.ok && result.url) {
      recordImplement(workspaceId, issueUrl, {
        state: 'done', url: result.url, error: null, worktree: kept,
        ...carriedImplement(workspaceId, issueUrl), endedAt: new Date().toISOString()
      });
      logger.info(`${issueUrl} implemented at ${result.url}`);
    } else {
      recordImplement(workspaceId, issueUrl, {
        state: 'failed', url: null, error: result.error ?? null, worktree: kept,
        ...carriedImplement(workspaceId, issueUrl), endedAt: new Date().toISOString()
      });
      logger.warn(`${issueUrl} implementation failed: ${result.error}`);
    }
  } catch (error) {
    recordImplement(workspaceId, issueUrl, {
      state: 'failed',
      url: null,
      error: (error as Error).message,
      worktree: await releaseWorktreeFor(workspace, worktree, issueUrl),
      ...carriedImplement(workspaceId, issueUrl),
      endedAt: new Date().toISOString()
    });
  }

  // A run settling is the moment a slot frees, and the only one this process can be sure of.
  // The timer exists for the other kind of change — a card dragged into Todo on GitHub — and
  // would find this one too, twenty or thirty seconds later; here it costs nothing to be
  // prompt about the thing the queue is actually for.
  void dispatchQueue(workspaceId);
}

// ─── The queue ────────────────────────────────────────────────
//
// On, and the server starts the oldest Todo issue whenever a slot frees. The switch itself is
// `implement-queue.ts`; this is what turns it into runs, and it is here rather than in the
// browser because the browser's poll is gated on tab visibility on purpose. A queue that
// stopped advancing when the tab was hidden would stop during exactly the hours it exists for.

/**
 * How often a draining workspace looks at its board.
 *
 * The event that matters — a run settling — is dispatched on directly, so this is only for
 * the changes this process cannot see: a card dragged into Todo on GitHub, an issue closed,
 * a slot freed by a reset. Every pass while the queue is on and a slot is free costs one `gh`
 * process, which is why the pass gives up before reading anything when the queue is off or
 * the cap is full, and why the timer does not exist at all until something turns a queue on.
 */
const IMPLEMENT_QUEUE_MS = (() => {
  const configured = process.env.EXCALIDRAW_IMPLEMENT_QUEUE_MS;
  if (configured === undefined || configured.trim() === '') return 30_000;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 250 ? parsed : 30_000;
})();

/**
 * The workspaces with a pass in flight.
 *
 * A pass reads the board and then starts runs one at a time, so two passes overlapping —
 * the timer and a run settling in the same instant — would each be working from a board read
 * before the other started. The claim guard would still hold the cap, but the second pass
 * would spend a `gh` read to be told no, every time.
 */
const draining = new Set<string>();

/** Whether this workspace has room for one more run right now. */
function slotFree(workspaceId: string): boolean {
  return IMPLEMENT_CONCURRENCY <= 0
    || runningImplements(workspaceId).length < IMPLEMENT_CONCURRENCY;
}

/**
 * Start as many queued issues as there are free slots, oldest first.
 *
 * The board is read **uncapped**. `projectCardLimit` decides what is *drawn*, and reading the
 * drawn mirror would mean working from a truncated column — the queue would drain what fits
 * on screen and silently never reach the rest. `moveIssueToColumn` reads uncapped for the
 * same reason.
 *
 * Each start goes through `beginImplement`, so the cap is enforced where it always was: at
 * the claim made before the first `await`. A `409` here is read as "not yet" and ends the
 * pass rather than being retried — a click that raced this pass has taken the slot, and the
 * next pass will find whatever it left.
 *
 * A card with any record against it is passed over, whatever the record says. `running` is
 * obvious; `done` and `failed` are the same rule as the block's — a run happened, and asking
 * for it again is a decision for whoever is reading the failure, not for a loop. That is also
 * what stops a broken build from being retried forever: the queue tries each issue once.
 */
async function dispatchQueue(workspaceId: string): Promise<void> {
  if (!IMPLEMENT_AGENT_CONFIGURED) return;
  if (!queueEnabled(workspaceId)) return;
  if (draining.has(workspaceId)) return;
  draining.add(workspaceId);

  try {
    if (!slotFree(workspaceId)) return;

    const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace || workspace.error || !workspace.githubProject) return;

    const board = await readProjectBoard(workspace, { cardLimit: 0 });
    const target = todoColumn(workspace);
    const column = findColumn(board, target.name);
    if (!column) {
      logger.warn(
        `Queue: no "${target.name}" column on this project, so there is nothing to drain. `
        + `Name the column as "${target.setting}" in board.config.json.`
      );
      return;
    }

    for (const card of startableCards(column.cards)) {
      // Re-read on every iteration rather than counted once: the queue is not the only thing
      // that can take a slot, and turning it off has to stop the pass it is in the middle of.
      if (!queueEnabled(workspaceId) || !slotFree(workspaceId)) return;
      const issueUrl = card.url as string;
      if (readImplement(workspaceId, issueUrl)) continue;

      const answer = await beginImplement(workspaceId, issueUrl);
      if (answer.status === 202) {
        logger.info(`Queue: started ${issueUrl} on "${workspaceId}"`);
        continue;
      }
      if (answer.status === 409) return;
      logger.warn(`Queue: ${issueUrl} was refused (${answer.status}): ${answer.body.error}`);
    }
  } catch (error) {
    // A board that cannot be read is a `gh` blip or a project that has gone; either way the
    // queue is a background convenience and must not take the server down with it.
    logger.warn(`Queue: could not drain "${workspaceId}": ${(error as Error).message}`);
  } finally {
    draining.delete(workspaceId);
  }
}

/**
 * The timer, which exists only while some workspace is draining.
 *
 * Started when the first queue goes on and stopped when the last goes off, rather than
 * running from startup: a board nobody has switched on must cost no `gh` at all. `unref` so
 * it is never the reason a process stays alive.
 */
let queueTimer: NodeJS.Timeout | null = null;

function syncQueueTimer(): void {
  const active = queuedWorkspaces();
  if (active.length > 0 && !queueTimer) {
    queueTimer = setInterval(() => {
      for (const workspaceId of queuedWorkspaces()) void dispatchQueue(workspaceId);
    }, IMPLEMENT_QUEUE_MS);
    queueTimer.unref?.();
  } else if (active.length === 0 && queueTimer) {
    clearInterval(queueTimer);
    queueTimer = null;
  }
}

/** What a queue looks like from outside: on or off, and the column it would drain. */
function queueStateFor(workspace: Workspace | undefined, workspaceId: string): {
  enabled: boolean;
  column: string;
} {
  return {
    enabled: queueEnabled(workspaceId),
    column: workspace ? todoColumn(workspace).name : DEFAULT_TODO_COLUMN
  };
}

/**
 * Tidy up after a run, and report what could not be tidied.
 *
 * A worktree holding uncommitted changes is kept, because those changes are the only copy
 * of themselves — an agent that died partway through a change leaves exactly that, and a
 * server that swept it away would be destroying the only evidence of what went wrong. It
 * is a warning in the log and a path on the record, so the run that failed is recoverable
 * by hand.
 */
async function releaseWorktreeFor(
  workspace: Workspace,
  worktree: ImplementWorktree | null,
  issueUrl: string
): Promise<string | null> {
  if (!worktree) return null;
  try {
    const released = await releaseWorktree(workspace, worktree);
    if (released.removed) return null;
    logger.warn(`Worktree kept for ${issueUrl}: uncommitted work at ${released.path}`);
    return released.path;
  } catch (error) {
    logger.warn(`Could not release the worktree for ${issueUrl}: ${(error as Error).message}`);
    return worktree.path;
  }
}

/**
 * Give back, at startup, the runs the previous process took with it.
 *
 * A run cannot survive the process that spawned it — the agent is a child, and the tree goes
 * together — so anything found here is over, whatever it looked like when it stopped. That is
 * what makes this safe to do once, on the way up, with nothing running to race against.
 *
 * Derived, not restored: `implement-recovery.ts` reads git, and git is the only participant
 * that was still there. Only runs the map does not already know about are written, which at
 * startup is all of them and would matter if this were ever called again.
 *
 * Not awaited by the caller, and not fatal. It spawns a handful of git processes per project,
 * and a board must not wait on them to start answering — the cost of that is that the record
 * appears a moment after the port opens, which is a moment nobody is looking at a panel in.
 */
async function recoverInterruptedRuns(): Promise<void> {
  let workspaces: Workspace[];
  try {
    workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  } catch (error) {
    logger.warn(`Could not look for interrupted implementations: ${(error as Error).message}`);
    return;
  }

  for (const workspace of workspaces) {
    if (workspace.error) continue;
    try {
      for (const run of await interruptedRuns(workspace)) {
        if (readImplement(workspace.id, run.issueUrl)) continue;
        const held: HeldWorktree = run.worktree;
        recordImplement(workspace.id, run.issueUrl, {
          state: 'interrupted',
          url: null,
          error: describeInterrupted(held),
          worktree: held.path,
          // Both null on purpose. The worktree knows what was done and not when it was
          // started or when it stopped, and an instant invented here would run a clock in
          // the panel counting time nobody spent.
          startedAt: null,
          endedAt: null,
          usage: null,
          // Nothing survives a restart here either: the sessions were the previous server's
          // and went down with it, so an id recovered from a worktree would name a tab that
          // stopped existing.
          terminal: null
        });
        logger.warn(
          `${run.issueUrl} was being implemented when a previous server stopped; `
          + `its checkout is still at ${held.path} (${held.commits} commit(s), ${held.changes} uncommitted path(s))`
        );
      }
    } catch (error) {
      logger.warn(
        `Could not look for interrupted implementations in "${workspace.id}": ${(error as Error).message}`
      );
    }
  }
}

/**
 * Put one registered board's saved scene into its store.
 *
 * Opt-in: a project that declares no `board` is left empty, which is the only way a board
 * that is genuinely meant to start blank can stay blank.
 *
 * Seeded by the *normalised* id. `elementsFor` normalises its argument and the registry
 * does not, so the raw id would reach the same store — but `broadcast` compares against
 * what a socket registered, which is normalised, and a project id with a capital letter
 * would be seeded correctly and told to nobody.
 */
async function seedBoardFromFile(workspace: Workspace): Promise<void> {
  if (workspace.error || !workspace.boardFile) return;

  const workspaceId = normalizeWorkspaceId(workspace.id);
  const store = elementsFor(workspaceId);
  if (store.size) {
    // Empty at startup, which is when this runs. Said out loud rather than assumed, because
    // the one thing this must never do is land on top of a board somebody is working on.
    logger.warn(`Not loading ${workspace.boardFile}: "${workspaceId}" already holds ${store.size} element(s).`);
    return;
  }

  let scene: BoardScene;
  try {
    scene = parseBoardScene(await fs.readFile(workspace.boardFile, 'utf-8'));
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'there is no such file'
      : (error as Error).message;
    logger.warn(`Board for "${workspaceId}" not loaded from ${workspace.boardFile}: ${reason}`);
    return;
  }

  if (!scene.elements.length) {
    logger.warn(`Board for "${workspaceId}" at ${workspace.boardFile} has no elements to load.`);
    return;
  }

  for (const element of scene.elements) store.set(element.id, element);
  // Content-addressed and process-wide, so a file already held is the same file.
  for (const [id, file] of Object.entries(scene.files)) if (!files.has(id)) files.set(id, file);

  // A direct store write tells nobody. A browser that connected while the read was in
  // flight took its `initial_elements` from an empty store, and would sit on a blank canvas
  // until something else made it refetch.
  broadcast({ type: 'elements_batch_created', elements: scene.elements } as BatchCreatedMessage, workspaceId);

  logger.info(`Loaded ${scene.elements.length} element(s) into "${workspaceId}" from ${workspace.boardFile}`);
}

/**
 * Give every registered board back the scene it was saved with.
 *
 * Boards are read concurrently rather than in turn: one of them lives on the `wsl$` share,
 * where a read crosses the distro boundary and is slow when the distro is running and
 * refused when it is not — and none of that is a reason for the three local boards to wait.
 * A board that cannot be read is warned about and skipped, one board at a time, for the
 * reason `loadWorkspace` returns a broken project instead of hiding it.
 */
async function seedBoardsFromFiles(): Promise<void> {
  let workspaces: Workspace[];
  try {
    workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  } catch (error) {
    logger.warn(`Could not look for boards to load: ${(error as Error).message}`);
    return;
  }

  await Promise.all(workspaces.map(async (workspace) => {
    try {
      await seedBoardFromFile(workspace);
    } catch (error) {
      logger.warn(`Could not load the board for "${workspace.id}": ${(error as Error).message}`);
    }
  }));
}

/** The agent writes to the repository, so every entrance carries the same two guards. */
function implementingRefused(res: Response): boolean {
  if (!IMPLEMENT_AGENT_CONFIGURED) {
    res.status(404).json({
      success: false,
      error: 'Implementing is disabled. Set EXCALIDRAW_IMPLEMENT_AGENT to the agent command to enable it.'
    });
    return true;
  }
  // This agent writes to the repository, which makes reaching this route from the network
  // strictly worse than reaching the issue route.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    res.status(403).json({
      success: false,
      error: 'Implementing only runs while the server is bound to loopback.'
    });
    return true;
  }
  return false;
}

app.post('/api/issue-block/:id/implement', async (req: Request, res: Response) => {
  const elementId = req.params.id ?? '';
  if (implementingRefused(res)) return;

  const workspaceId = workspaceIdFrom(req);
  const element = elementsFor(workspaceId).get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  const issueUrl = typeof custom.issueUrl === 'string' ? custom.issueUrl : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'This block has no issue to implement.' });
  }

  const answer = await beginImplement(workspaceId, issueUrl, {
    resume: req.body?.resume === true,
    interactive: req.body?.interactive === true
  });
  res.status(answer.status).json(answer.body);
});

/**
 * The same thing, for a shape the server has never seen.
 *
 * A mirrored card is drawn from GitHub and never synced, so there is no element id to name
 * it by — but there is an issue, and the issue is what is being implemented.
 *
 * `resume: true` continues an interrupted attempt instead of starting one. A flag on the
 * existing route rather than a route of its own, because it is one run either way: what
 * changes is a paragraph of the prompt, and every guard around it is the same.
 *
 * `interactive: true` asks for the tab to be one the reader can answer, and is a flag here
 * for the same reason: it is the same run, in the same worktree, with the same prompt. What
 * it changes is the command line — the print flags come off it, so everything downstream
 * that already reads the command's *shape* gives the run a pseudoterminal, hands it the
 * prompt as an argument and leaves stdin to the reader. This is #220's comment: the choice
 * between the two shapes was the operator's command line and a server restart, and it is now
 * also a click. The queue never asks for it — an interactive run does not end by itself.
 */
app.post('/api/implement', async (req: Request, res: Response) => {
  if (implementingRefused(res)) return;

  const issueUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'No issue URL was given.' });
  }

  const answer = await beginImplement(workspaceIdFrom(req), issueUrl, {
    resume: req.body?.resume === true,
    interactive: req.body?.interactive === true
  });
  res.status(answer.status).json(answer.body);
});

/**
 * Turn this workspace's queue on or off.
 *
 * Behind the same two guards as starting a run, and for the same reason: this is a switch
 * that spawns coding agents against a repository, one per free slot, with nobody clicking.
 * A canvas reachable from the network must not be able to flip it.
 *
 * Turning it on dispatches immediately rather than waiting out an interval — the click is
 * the moment somebody said "start draining", and a button that appeared to do nothing for
 * half a minute would be clicked again.
 */
app.post('/api/implement/queue', async (req: Request, res: Response) => {
  if (implementingRefused(res)) return;

  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'The queue is set with { "enabled": true | false }.' });
  }

  const workspaceId = workspaceIdFrom(req);
  const enabled = req.body.enabled === true;
  setQueueEnabled(workspaceId, enabled);
  syncQueueTimer();
  logger.info(`Queue: "${workspaceId}" is ${enabled ? 'on' : 'off'}`);
  if (enabled) void dispatchQueue(workspaceId);

  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES).catch(() => []);
  res.json({
    success: true,
    queue: queueStateFor(workspaces.find((candidate) => candidate.id === workspaceId), workspaceId)
  });
});

/**
 * Clear a stuck implementation so the block can be tried again.
 *
 * The timeout used to guarantee that a wedged run could not hold a block in `running`
 * forever. Implementing has no timeout — a clock that kills a working agent halfway
 * through a change is worse than one that never fires — so that guarantee has to come
 * from somewhere, and this is it.
 *
 * This clears state; it does not stop an agent. Nothing here can reach into a process the
 * server no longer owns, and a button that claimed to would be lying. What it can do is
 * refuse while a run is in flight *in this process*, which is the case that actually
 * matters: the state on the element cannot tell a live run from an abandoned one, and the
 * server can.
 */
function resetImplement(res: Response, workspaceId: string, issueUrl: string): void {
  if (isImplementing(workspaceId, issueUrl)) {
    res.status(409).json({
      success: false,
      error: 'An implementation is running right now. Resetting would only hide it.'
    });
    return;
  }

  recordImplement(workspaceId, issueUrl, null);
  res.json({ success: true, issueUrl });
}

app.delete('/api/issue-block/:id/implement', (req: Request, res: Response) => {
  const elementId = req.params.id ?? '';
  const workspaceId = workspaceIdFrom(req);
  const element = elementsFor(workspaceId).get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  const issueUrl = typeof custom.issueUrl === 'string' ? custom.issueUrl : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'This block has no issue to reset.' });
  }

  resetImplement(res, workspaceId, issueUrl);
});

/**
 * Just the implementation's state, with no issue read behind it.
 *
 * A card with a run in flight has to find out when it finishes, and it cannot be told:
 * there is no element for the socket to update. So it asks — and asking must not cost a
 * `gh` process each time, which is what reading through /api/issue would.
 *
 * With no `url`, every record for the workspace instead. Once several runs can be in
 * flight at once, "what is running right now" is a real question, and it used to have no
 * answer: the state was reachable only one issue at a time, by a caller who already knew
 * which issue to ask about. Finished runs come back too — one of the things worth knowing
 * is which run left a worktree behind.
 *
 * The queue rides on that same answer rather than on a route of its own: the mirror already
 * asks this once per poll, for the marks on the cards, and the toggle's two appearances have
 * to survive every redraw — so the state that decides them has to arrive with the redraw's
 * own data or it will be one poll behind. `queue` is **absent** rather than off when
 * implementing is disabled or the server is not on loopback, because a button that cannot do
 * anything should not be drawn at all.
 */
app.get('/api/implement', async (req: Request, res: Response) => {
  const workspaceId = workspaceIdFrom(req);
  const issueUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (issueUrl) {
    return res.json({ success: true, implement: readImplement(workspaceId, issueUrl) });
  }

  const offered = IMPLEMENT_AGENT_CONFIGURED
    && (LOOPBACK_ADDRESSES.includes(HOST) || HOST === 'localhost');
  const workspaces = offered
    ? await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES).catch(() => [])
    : [];

  res.json({
    success: true,
    runs: listImplement(workspaceId),
    concurrency: IMPLEMENT_CONCURRENCY,
    ...(offered
      ? { queue: queueStateFor(workspaces.find((candidate) => candidate.id === workspaceId), workspaceId) }
      : {})
  });
});

/** The same reset, for a mirrored card with no element behind it. */
app.delete('/api/implement', (req: Request, res: Response) => {
  const issueUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'No issue URL was given.' });
  }
  resetImplement(res, workspaceIdFrom(req), issueUrl);
});

/**
 * The issue behind a card, read live, with whatever is known about implementing it.
 *
 * Addressed by URL rather than by element because a mirrored card has no element. The
 * implement record rides along so selecting a card costs one round trip rather than two.
 */
app.get('/api/issue', async (req: Request, res: Response) => {
  // Reading is not writing, but it still spawns a process holding the user's gh
  // credentials — the same reason the run route is loopback-only.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'Issues only read while the server is bound to loopback.'
    });
  }

  const issueUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!isIssueUrl(issueUrl)) {
    return res.status(400).json({ success: false, error: `Not a GitHub issue URL: ${issueUrl}` });
  }

  const workspaceId = workspaceIdFrom(req);
  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || workspace.error) {
    return res.status(400).json({
      success: false,
      error: workspace?.error ?? `Workspace "${workspaceId}" is not registered.`
    });
  }

  try {
    const issue = await issueMemo.read(workspaceId, issueUrl, () => fetchIssue(workspace, issueUrl));
    res.json({ success: true, issue, implement: readImplement(workspaceId, issueUrl) });
  } catch (error) {
    // 502: the failure is GitHub's or gh's, not the caller's request.
    res.status(502).json({ success: false, error: (error as Error).message });
  }
});

/**
 * Add an observation to an issue that already exists.
 *
 * Between the two agent runs there was nothing to say anything with. The issue agent is
 * told to end with the questions it could not answer, and the implement agent is told to
 * decide them alone because nobody can answer mid-run — so an answer, or anything the
 * observation missed, had to be typed on github.com in another window.
 *
 * Keyed by URL for the same reason implementing is: the panel also serves a mirrored card
 * the server has never seen, which has no element id to name it by.
 *
 * The loopback guard and nothing else. This writes to GitHub, so a canvas reachable from
 * the network must not reach it — but it starts no agent and touches no repository, so
 * `POST /api/project-board/move` is the precedent rather than the implement routes' opt-in
 * environment variable.
 */
app.post('/api/issue/comment', async (req: Request, res: Response) => {
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'Issues only take comments while the server is bound to loopback.'
    });
  }

  const issueUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!isIssueUrl(issueUrl)) {
    return res.status(400).json({ success: false, error: `Not a GitHub issue URL: ${issueUrl}` });
  }

  // Posted as typed, trailing newlines and all — the point of this route is that the text
  // arrives unchanged. Only "is there anything here at all" is judged, and an accidental
  // click on an empty box must not become an empty comment on somebody's issue.
  const body = typeof req.body?.body === 'string' ? req.body.body : '';
  if (!body.trim()) {
    return res.status(400).json({ success: false, error: 'An empty observation has nothing to add.' });
  }

  const workspaceId = workspaceIdFrom(req);
  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || workspace.error) {
    return res.status(400).json({
      success: false,
      error: workspace?.error ?? `Workspace "${workspaceId}" is not registered.`
    });
  }

  try {
    await commentOnIssue(workspace, issueUrl, body);
  } catch (error) {
    // 502: the failure is GitHub's or gh's, not the caller's request.
    return res.status(502).json({ success: false, error: (error as Error).message });
  }

  // Read back so the panel can show the comment without a reload. Deliberately after the
  // post has been reported as succeeding: a read that fails is not a comment that failed,
  // and telling the reader otherwise would invite a second one.
  //
  // The memo is dropped first, because the comment just made whatever it holds wrong — and
  // the read that replaces it becomes what the next selection is served.
  issueMemo.forget(workspaceId, issueUrl);
  try {
    const issue = await issueMemo.read(workspaceId, issueUrl, () => fetchIssue(workspace, issueUrl));
    res.json({ success: true, issue });
  } catch (error) {
    logger.warn(`Commented on ${issueUrl} but could not read it back: ${(error as Error).message}`);
    res.json({ success: true, issue: null });
  }
});

// ─── Researching an issue again ───────────────────────────────
//
// **Add observations** above can only append. A comment cannot correct a body, and the next
// reader of an issue this board opened is an unattended coding agent — which is then asked to
// reconcile two texts that contradict each other, when what the reader wanted was one text
// that is right. So a first investigation that went the wrong way is rewritten rather than
// annotated: the same issue number, the same project card, the same comments.
//
// That is only defensible while nothing has been built against the issue, which is what the
// Todo gate below is. Rewriting a body under a live implement agent would change the
// specification behind its back, with no way to tell the agent that read the issue when it
// started.

/** What a recreate run has done so far, kept against the issue rather than a shape. */
interface RecreateRecord {
  state: 'running' | 'done' | 'failed';
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * What the run has spent, when the agent is willing to say.
   *
   * The same opt-in as everywhere else — null unless the configured command already asks for
   * a machine-readable stream — and here for the reason `docs/whats-next.md` gives about the
   * two research runs: they are one seam, not two, so a rewrite reports its spending the way
   * a first investigation does. See `src/core/agent-usage.ts`.
   */
  usage: AgentUsage | null;
}

/**
 * The runs, per workspace and issue URL.
 *
 * In memory and against the URL, because there is nothing else to hang it on: a mirrored card
 * has no element, has no `issueState` to hold `running`, and is redrawn from GitHub on every
 * poll. The panel polls this while its run is in flight, the way it polls the implement
 * record, and that is the whole lifetime — a recreate that was interrupted by a restart is
 * simply forgotten, which is honest: nothing on GitHub is left half-written by one, because
 * the edit an agent makes is a single call that either happened or did not.
 */
const recreateRuns = new Map<string, RecreateRecord>();
const recreateKey = (workspaceId: string, issueUrl: string): string => `${workspaceId}\n${issueUrl}`;

/**
 * Why this issue may not be researched again, or null when it may.
 *
 * Strict Todo, and strict about what "Todo" is: the workspace's own `projectTodoColumn`,
 * matched the way every other column lookup here is. A card in *No Status*, or in a column
 * somebody invented, has nothing started against it either — but "in Todo" is what the
 * observation this came from asked for, it is where a research run already puts a created
 * issue, and it is the rule a reader can predict without knowing this function.
 *
 * A board with no project has no column at all, so there is nothing to gate on and nothing is
 * read: a dormant board stays exactly as dormant as it was.
 */
async function todoColumnRefusal(workspace: Workspace, issueUrl: string): Promise<string | null> {
  if (!workspace.githubProject) return null;

  // Uncapped: the cap decides what is *drawn*, and a card hidden behind it would read here as
  // an issue that is not on the project at all.
  const board = await readProjectBoard(workspace, { cardLimit: 0 });
  const target = todoColumn(workspace);
  const found = board.sections
    .flatMap((section) => section.cards.map((card) => ({ section, card })))
    .find((entry) => entry.card.url === issueUrl);

  if (!found) {
    return `${issueUrl} is not on this project, so there is no "${target.name}" column it could be waiting in.`;
  }
  if (found.section.name.trim().toLowerCase() !== target.name.trim().toLowerCase()) {
    return `Its card is in "${found.section.name}", not "${target.name}". An issue is only researched again `
      + 'while nothing has been started against it.';
  }
  return null;
}

/**
 * Rewrite an issue this board opened, from new observations.
 *
 * Guarded like the run route rather than like the comment route, because it spawns an agent:
 * `EXCALIDRAW_ISSUE_AGENT` set, loopback only, and one run in flight per issue URL.
 *
 * **It is not a second entrance to `POST /api/issue-block/:id`.** That route still answers 409
 * for any block carrying an `issueUrl`, and `DELETE` still refuses to make such a block
 * runnable — the guard that stops one observation becoming two issues is untouched, because
 * this one opens no issue at all.
 */
app.post('/api/issue/recreate', async (req: Request, res: Response) => {
  if (!ISSUE_AGENT_CONFIGURED) {
    return res.status(404).json({
      success: false,
      error: 'Researching an issue again is disabled. Set EXCALIDRAW_ISSUE_AGENT to the agent command to enable it.'
    });
  }
  if (offLoopback(res, 'Issues are researched again')) return;

  const issueUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!isIssueUrl(issueUrl)) {
    return res.status(400).json({ success: false, error: `Not a GitHub issue URL: ${issueUrl}` });
  }

  // Kept as typed, trailing newlines and all: the observations are what the run is *about*,
  // and they are posted to the issue verbatim. Only "is there anything here at all" is judged.
  const observations = typeof req.body?.observations === 'string' ? req.body.observations : '';
  if (!observations.trim()) {
    return res.status(400).json({ success: false, error: 'There is nothing to research again.' });
  }

  const workspaceId = workspaceIdFrom(req);
  const key = recreateKey(workspaceId, issueUrl);
  if (recreateRuns.get(key)?.state === 'running') {
    return res.status(409).json({ success: false, error: 'A recreate is already in flight for this issue.' });
  }

  const implementing = readImplement(workspaceId, issueUrl);
  if (implementing) {
    return res.status(409).json({
      success: false,
      error: `This workspace holds an implementation against this issue (${implementing.state}). `
        + 'Rewriting it now would change the specification an agent has already read.'
    });
  }

  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || workspace.error) {
    return res.status(400).json({
      success: false,
      error: workspace?.error ?? `Workspace "${workspaceId}" is not registered.`
    });
  }

  const agentCommand = agentCommandOrRefuse(
    res, workspace, ISSUE_AGENT_COMMANDS, 'Researching an issue again', 'EXCALIDRAW_ISSUE_AGENT'
  );
  if (!agentCommand) return;

  // Read rather than taken from the memo: a thirty-second-old "OPEN" is fine for drawing a
  // panel and is not fine for deciding whether to send an agent at somebody's issue.
  try {
    const issue = await fetchIssue(workspace, issueUrl);
    if (issue.state.toUpperCase() === 'CLOSED') {
      return res.status(409).json({
        success: false,
        error: 'This issue is closed, so there is nothing left to research again.'
      });
    }
  } catch (error) {
    // 502: the failure is GitHub's or gh's, not the caller's request.
    return res.status(502).json({ success: false, error: (error as Error).message });
  }

  try {
    const refusal = await todoColumnRefusal(workspace, issueUrl);
    if (refusal) return res.status(409).json({ success: false, error: refusal });
  } catch (error) {
    return res.status(502).json({ success: false, error: (error as Error).message });
  }

  recreateRuns.set(key, {
    state: 'running', error: null, startedAt: new Date().toISOString(), endedAt: null, usage: null
  });
  // Answer immediately: an investigation takes minutes, and a request held open that long
  // looks indistinguishable from a hang. The panel polls the record.
  res.status(202).json({ success: true, state: 'running', issueUrl });

  /**
   * The totals onto the record, and nowhere else — there is nowhere else for a rewrite.
   *
   * A recreate leaves nothing on a shape while it runs, on purpose: a mirrored card has no
   * element at all. Ignored once the run has settled, so a report still in flight when the
   * process closes cannot resurrect a finished record.
   */
  const takeUsage = (usage: AgentUsage): void => {
    const existing = recreateRuns.get(key);
    if (!existing || existing.state !== 'running') return;
    recreateRuns.set(key, { ...existing, usage });
  };

  const settle = (state: 'done' | 'failed', error: string | null): void => {
    const existing = recreateRuns.get(key);
    recreateRuns.set(key, {
      state,
      error,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      // Read back rather than rebuilt from a literal, for the reason `carriedImplement`
      // exists: the figures arrive throughout the run, and a record reassembled at the end
      // would throw them away exactly when the total became worth reading.
      usage: existing?.usage ?? null
    });
    // Whatever was remembered about the issue is now wrong twice over — the comment below and,
    // on the success path, the body itself. Dropped rather than waited out, so selecting the
    // card straight afterwards shows what the run produced instead of what it replaced.
    issueMemo.forget(workspaceId, issueUrl);
  };

  try {
    // The observations reach the issue before the agent does, and they reach it as a comment.
    // Two reasons, and both are about what is left behind: a body that changed with nothing on
    // the issue explaining why is a body nobody can review, and a run that dies having posted
    // this has left the reader exactly where **Add observations** would have — which is a far
    // better failure than one that loses what they typed. Never fatal, for the same reason a
    // board write is not: the rewrite is the point, and `gh` drops a socket here often enough.
    try {
      await commentOnIssue(workspace, issueUrl, observations);
    } catch (error) {
      logger.warn(`Recreate ${issueUrl}: could not record the observations on the issue — ${(error as Error).message}`);
    }

    const result = await runReviseAgent(workspace, issueUrl, observations, {
      agentCommand,
      notFoundVariable: 'EXCALIDRAW_ISSUE_AGENT_WSL',
      onUsage: takeUsage
    });

    // A run is read as successful from the URL it printed, the way researching is — and here
    // there is one right answer. An agent that named a different issue opened one rather than
    // rewriting this one, and recording that as a rewrite would be the board believing that
    // the issue in front of the reader is now correct when it is untouched.
    if (result.ok && result.issueUrl === issueUrl) {
      settle('done', null);
      logger.info(`Recreate: ${issueUrl} was researched again and rewritten`);
    } else if (result.ok && result.issueUrl) {
      settle('failed', `The agent answered with ${result.issueUrl} rather than rewriting ${issueUrl}.`);
      logger.warn(`Recreate ${issueUrl}: the agent answered with ${result.issueUrl}`);
    } else {
      settle('failed', result.error ?? 'The agent finished without rewriting the issue.');
      logger.warn(`Recreate ${issueUrl} failed: ${result.error}`);
    }
  } catch (error) {
    settle('failed', (error as Error).message);
  }
});

/**
 * What a recreate has done so far, with no `gh` behind it.
 *
 * The panel cannot be told: a mirrored card has no element for the socket to update, and a
 * recreate leaves nothing on a shape while it runs. So it asks, and asking has to be free.
 */
app.get('/api/issue/recreate', (req: Request, res: Response) => {
  const issueUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'No issue URL was given.' });
  }
  res.json({
    success: true,
    recreate: recreateRuns.get(recreateKey(workspaceIdFrom(req), issueUrl)) ?? null
  });
});

/**
 * The issue behind a block, read live.
 *
 * Read at selection time rather than copied onto the element at creation time: the body
 * is kilobytes that would otherwise ride in every autosync payload and every export, and
 * it would go stale as soon as anyone edited the issue on GitHub.
 */
app.get('/api/issue-block/:id/issue', async (req: Request, res: Response) => {
  const elementId = req.params.id ?? '';

  // Reading is not writing, but it still spawns a process holding the user's gh
  // credentials — the same reason the run route is loopback-only.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'Issue blocks only read while the server is bound to loopback.'
    });
  }

  const workspaceId = workspaceIdFrom(req);
  const element = elementsFor(workspaceId).get(elementId);
  if (!element) {
    return res.status(404).json({ success: false, error: `Element ${elementId} not found` });
  }

  const custom = (element.customData ?? {}) as Record<string, unknown>;
  const issueUrl = typeof custom.issueUrl === 'string' ? custom.issueUrl : '';
  if (!issueUrl) {
    return res.status(404).json({ success: false, error: 'This block has no issue yet.' });
  }

  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || workspace.error) {
    return res.status(400).json({
      success: false,
      error: workspace?.error ?? `Workspace "${workspaceId}" is not registered.`
    });
  }

  try {
    // The same memo the URL-addressed route uses: one issue, one read, whichever shape asked
    // for it — an authored block and a mirrored card must not each spawn a `gh` of their own.
    const issue = await issueMemo.read(workspaceId, issueUrl, () => fetchIssue(workspace, issueUrl));
    res.json({ success: true, issue });
  } catch (error) {
    // 502: the failure is GitHub's or gh's, not the caller's request.
    res.status(502).json({ success: false, error: (error as Error).message });
  }
});

// ─── Project board mirror ─────────────────────────────────────
//
// A region of the canvas showing the workspace's GitHub project: one section per option
// of a single-select field, cards newest-first, and a drag between columns written back.
// Dormant unless a project says `githubProject`, so a board that has none never grows one.
//
// Both directions go through `gh`. It is already required by the issue agent, already
// carries the `project` scope, and the PATH and WSL traps around it are already paid for.

/** The workspace a project-board request is about, or a reason it is not usable. */
async function projectWorkspace(req: Request): Promise<{ workspace: Workspace } | { error: string }> {
  const workspaceId = workspaceIdFrom(req);
  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return { error: `Workspace "${workspaceId}" is not registered, so it has no GitHub project.` };
  }
  if (workspace.error) return { error: `Workspace is unusable: ${workspace.error}` };
  if (!workspace.githubProject) {
    return { error: 'This board has no "githubProject" in its board.config.json.' };
  }
  return { workspace };
}

app.get('/api/project-board', async (req: Request, res: Response) => {
  // Reading is not writing, but it still spawns a process holding the user's gh
  // credentials — the same reason the issue block's read route is loopback-only.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'The project board only reads while the server is bound to loopback.'
    });
  }

  const resolved = await projectWorkspace(req);
  if ('error' in resolved) {
    // 404 rather than 400: the feature is absent for this board, not misused.
    return res.status(404).json({ success: false, error: resolved.error });
  }

  try {
    const board = await readProjectBoard(resolved.workspace);
    res.json({ success: true, board });
  } catch (error) {
    if (error instanceof NoProjectConfigured) {
      return res.status(404).json({ success: false, error: (error as Error).message });
    }
    // 502: the failure is GitHub's or gh's, not the caller's request.
    logger.warn(`Project board read failed: ${(error as Error).message}`);
    res.status(502).json({ success: false, error: (error as Error).message });
  }
});

/**
 * Move a card to another column.
 *
 * Behind the same loopback guard as the issue block's run route, and for a stronger
 * reason: this one writes. A canvas reachable from the network must not be able to
 * rearrange somebody's project board.
 */
app.post('/api/project-board/move', async (req: Request, res: Response) => {
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    return res.status(403).json({
      success: false,
      error: 'The project board only moves cards while the server is bound to loopback.'
    });
  }

  const itemId = typeof req.body?.itemId === 'string' ? req.body.itemId.trim() : '';
  const optionId = typeof req.body?.optionId === 'string' ? req.body.optionId.trim() : '';
  if (!itemId || !optionId) {
    return res.status(400).json({ success: false, error: 'A move needs an itemId and an optionId.' });
  }

  const resolved = await projectWorkspace(req);
  if ('error' in resolved) {
    return res.status(404).json({ success: false, error: resolved.error });
  }

  try {
    const board = await moveCard(resolved.workspace, itemId, optionId);
    res.json({ success: true, board });
  } catch (error) {
    if (error instanceof NoProjectConfigured) {
      return res.status(404).json({ success: false, error: (error as Error).message });
    }
    if (error instanceof NotOnThisBoard) {
      return res.status(400).json({ success: false, error: (error as Error).message });
    }
    logger.warn(`Project board move failed: ${(error as Error).message}`);
    res.status(502).json({ success: false, error: (error as Error).message });
  }
});

// ─── Library API (shared shapes) ──────────────────────────────
//
// Recurring shapes were rebuilt by hand on every board, so consistency depended on
// repeating literal coordinates and colours. A library turns them into named pieces.
// A project's own library wins over the shared one, so a project can extend or
// override the common set without editing it.
async function readLibrary(filePath: string): Promise<unknown[]> {
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  if (!Array.isArray(parsed?.libraryItems)) {
    throw new Error('Not an .excalidrawlib file: no libraryItems array');
  }
  return parsed.libraryItems;
}

app.get('/api/library', async (req: Request, res: Response) => {
  const sources: { origin: string; path: string }[] = [];

  if (process.env.EXCALIDRAW_LIBRARY) {
    sources.push({ origin: 'shared', path: path.resolve(process.env.EXCALIDRAW_LIBRARY) });
  }

  const workspaceId = workspaceIdFrom(req);
  if (workspaceId !== DEFAULT_WORKSPACE_ID) {
    const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace?.libraryFile) {
      sources.push({ origin: 'workspace', path: path.resolve(workspace.libraryFile) });
    }
  }

  const libraryItems: unknown[] = [];
  const errors: string[] = [];
  for (const source of sources) {
    try {
      libraryItems.push(...(await readLibrary(source.path)));
    } catch (error) {
      // A broken library must not block the canvas: the board is still usable
      // without its shapes, and a blank page would hide the real problem.
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `not found: ${source.path}`
        : (error as Error).message;
      errors.push(`${source.origin} library ${reason}`);
      logger.warn(`Library skipped — ${source.origin}: ${reason}`);
    }
  }

  res.json({ success: true, libraryItems, errors });
});

// ─── The terminal ─────────────────────────────────────────────
//
// A shell the server owns, running in a workspace, streaming as it goes. It is a strictly
// worse thing to leave reachable than the issue block — that one spawns a process with a
// fixed prompt, this one runs whatever arrives — so it copies the issue block's guards
// exactly: opt in by environment variable, loopback only, and a capped number of sessions
// per workspace.
//
// The count was one and is now `TERMINAL_SESSION_LIMIT`, which is a guard **relaxed** rather
// than removed: a page that could ask in a loop would otherwise be asking for as many shells
// as it liked. The other two are untouched.
//
// `EXCALIDRAW_TERMINAL` unset means these routes do not exist. Not "answer 403", not
// "answer with an empty session": 404, the same shape the issue block uses, so a canvas
// that never turned it on cannot tell a disabled feature from an absent one.
const TERMINAL_SETTING = process.env.EXCALIDRAW_TERMINAL || null;

/**
 * Every session, by board and then by id.
 *
 * Two levels rather than a joined key, because both questions get asked: "which sessions
 * does this board have" is the list a viewer connects into, and "which session is this" is
 * every route below.
 */
const terminalSessions = new Map<string, Map<string, TerminalSession>>();

/** What the next session on a board is called. Never reused, so an id is never ambiguous. */
const terminalCounters = new Map<string, number>();

function terminalSessionsFor(workspaceId: string): Map<string, TerminalSession> {
  const existing = terminalSessions.get(workspaceId);
  if (existing) return existing;
  const created = new Map<string, TerminalSession>();
  terminalSessions.set(workspaceId, created);
  return created;
}

/** Short and readable, because it is also what a tab on the block is labelled with. */
function nextTerminalId(workspaceId: string): string {
  const next = (terminalCounters.get(workspaceId) ?? 0) + 1;
  terminalCounters.set(workspaceId, next);
  return `s${next}`;
}

/** One session, as a viewer that has not been watching needs it. */
function terminalReplay(session: TerminalSession): Record<string, unknown> {
  return { session: session.summary(), scrollback: session.scrollback, sequence: session.sequence };
}

/**
 * The two guards, in one place.
 *
 * Returns true when the request has been answered and the caller must stop. Written once
 * rather than per route because five routes with the guards copied five times is five
 * chances to leave one out, and the one left out would be the hole.
 */
function terminalRefused(res: Response): boolean {
  if (!TERMINAL_SETTING) {
    res.status(404).json({
      success: false,
      error: 'The terminal is disabled. Set EXCALIDRAW_TERMINAL to enable it.'
    });
    return true;
  }
  // A shell on this port is remote code execution for anyone who can reach it.
  if (!LOOPBACK_ADDRESSES.includes(HOST) && HOST !== 'localhost') {
    res.status(403).json({
      success: false,
      error: 'The terminal only runs while the server is bound to loopback.'
    });
    return true;
  }
  return false;
}

/**
 * The session a request names, or the answer explaining why there is none.
 *
 * The id is optional, and what makes that safe is that its absence is never *guessed* at.
 * With one session open there is nothing to be ambiguous between, and the routes stay
 * scriptable by hand the way `docs/terminal.md` describes them. With several, an unnamed
 * request is a 400 that lists them rather than a shell chosen by iteration order — "whichever
 * one is open" is precisely the defect that made tabs impossible.
 */
function requireTerminal(req: Request, res: Response): TerminalSession | null {
  const sessions = terminalSessionsFor(workspaceIdFrom(req));
  const named = typeof req.body?.sessionId === 'string'
    ? req.body.sessionId
    : (typeof req.query.sessionId === 'string' ? req.query.sessionId : null);

  if (named) {
    const session = sessions.get(named);
    if (!session) {
      res.status(404).json({ success: false, error: `No terminal session "${named}" is open for this board.` });
      return null;
    }
    return session;
  }

  if (sessions.size === 0) {
    res.status(404).json({ success: false, error: 'No terminal session is open for this board.' });
    return null;
  }
  if (sessions.size > 1) {
    res.status(400).json({
      success: false,
      error: `This board has ${sessions.size} terminal sessions open, so the request must name one in "sessionId".`,
      sessions: Array.from(sessions.keys())
    });
    return null;
  }
  return sessions.values().next().value ?? null;
}

/** Whether a session could be opened at all, for a caller with no response to write. */
function terminalAvailable(): boolean {
  return Boolean(TERMINAL_SETTING)
    && (LOOPBACK_ADDRESSES.includes(HOST) || HOST === 'localhost');
}

/** What opening a session came to, for a caller that has to say why it did not. */
type TerminalStart =
  | { ok: true; session: TerminalSession }
  | { ok: false; reason: 'cap' | 'error'; error: string };

/**
 * Open a session on a board, however it was asked for.
 *
 * The route was the only entrance until a run needed one too, and a second copy of this
 * would be a second place for the cap to be counted, the id to be allocated and the
 * announcement to be broadcast — three things a board can only survive having once. So both
 * come through here, and the *only* difference between them is what is in `options`: a
 * reader's session names no command of its own, no directory and no owner, which is what
 * keeps it byte for byte the session it was.
 *
 * `watch` is what a caller that is not a socket needs: the chunks and the ending, as they
 * happen. The broadcast happens either way — a run being watched by the server is still a
 * run every open board should see.
 */
async function startTerminalSession(
  workspace: Workspace,
  shellCommand: string,
  pty: PtyModule | null,
  options: TerminalSessionOptions = {},
  watch: { onOutput?: (chunk: string) => void; onExit?: (code: number | null) => void } = {}
): Promise<TerminalStart> {
  const workspaceId = workspace.id;
  const sessions = terminalSessionsFor(workspaceId);
  if (sessions.size >= TERMINAL_SESSION_LIMIT) {
    return {
      ok: false,
      reason: 'cap',
      error: `This board already has ${sessions.size} terminal sessions open, `
        + `which is the cap of ${TERMINAL_SESSION_LIMIT}. Close one first.`
    };
  }

  const sessionId = nextTerminalId(workspaceId);
  let session: TerminalSession;
  try {
    session = new TerminalSession(sessionId, workspace, shellCommand, {
      // The two readers of one stream, kept apart. The tap reads for a pull request URL and
      // for token counts, and both live in the JSON envelopes the transcript has rendered
      // away by the time `onOutput` fires — so the tap takes the raw chunk and only the
      // browser is sent the readable one.
      onRaw: (data) => {
        watch.onOutput?.(data);
      },
      onOutput: (data, sequence) => {
        broadcast({ type: 'terminal_output', sessionId, data, sequence } as WebSocketMessage, workspaceId);
      },
      onExit: (code) => {
        // Dropped from the map here rather than on the DELETE, because a shell that ended
        // on its own — `exit`, or a crash — has to free the slot too. Only if it is still
        // the one under that id: ids are never reused, so this is belt and braces, but a
        // session evicting a successor is exactly the bug the old single-slot map could have.
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        broadcast({ type: 'terminal_exit', sessionId, code } as WebSocketMessage, workspaceId);
        watch.onExit?.(code);
      }
    }, pty, options);
  } catch (error) {
    logger.error('Could not start a terminal:', error);
    return { ok: false, reason: 'error', error: (error as Error).message };
  }

  // A ConPTY reports no process id until its console host has connected, and a session
  // announced before then would carry a 0 into the block and into `taskkill` on the way out.
  await session.started;

  sessions.set(sessionId, session);
  broadcast({
    type: 'terminal_session',
    session: session.summary(),
    scrollback: session.scrollback,
    sequence: session.sequence
  } as WebSocketMessage, workspaceId);

  return { ok: true, session };
}

app.post('/api/terminal', async (req: Request, res: Response) => {
  if (terminalRefused(res)) return;

  const workspaceId = workspaceIdFrom(req);
  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return res.status(400).json({
      success: false,
      error: `Workspace "${workspaceId}" is not registered, so there is no project to run in.`
    });
  }
  if (workspace.error) {
    return res.status(400).json({ success: false, error: `Workspace is unusable: ${workspace.error}` });
  }

  // Which mode this session will be in has to be settled before the shell is named: the
  // default shell is spelled differently for each. PowerShell's `-Command -` refuses to
  // start at all when stdin is a terminal, so a PTY session asks for the plain REPL.
  const pty = await loadPty();
  // A command in the body names what to run instead of the configured shell, and a `cwd`
  // names where. Neither grants anything the route did not already grant — a shell is a
  // thing you type commands and `cd` into — and both are still behind the same three
  // guards. They exist because the server itself needs to ask for a session that is not the
  // default one, and a facility only the server can reach is one nothing can check by hand.
  const asked = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
  const shellCommand = asked || shellCommandFrom(TERMINAL_SETTING, workspace, pty ? 'pty' : 'pipe');
  if (!shellCommand) {
    return res.status(404).json({
      success: false,
      error: 'The terminal is disabled. Set EXCALIDRAW_TERMINAL to enable it.'
    });
  }
  // One path, spelled the way the caller's own environment spells it: inside a WSL distro
  // only `innerPath` is ever used, and outside one only `path` is, so a caller that gives
  // the right spelling for its workspace is right in both.
  const cwd = typeof req.body?.cwd === 'string' && req.body.cwd.trim()
    ? { path: req.body.cwd.trim(), innerPath: req.body.cwd.trim() }
    : null;

  const started = await startTerminalSession(workspace, shellCommand, pty, { directory: cwd });
  if (!started.ok) {
    // Still a 409 for the cap, and still for the same reason it was one when the cap was 1:
    // the number of shells a board may run is a guard, and a request past it is a conflict
    // with that guard rather than a request that failed. It names the cap, because a refusal
    // that does not say what the limit is leaves a caller retrying against a wall it cannot see.
    if (started.reason === 'cap') {
      return res.status(409).json({
        success: false,
        error: started.error,
        sessions: Array.from(terminalSessionsFor(workspaceId).values()).map((one) => one.summary())
      });
    }
    return res.status(500).json({ success: false, error: started.error });
  }

  // 202, like starting an agent: the shell is running, and what it produces arrives over
  // the socket rather than in this response.
  res.status(202).json({ success: true, session: started.session.summary() });
});

/**
 * A place for an implementation to run where the board can show it, or nothing at all.
 *
 * Nothing at all whenever the terminal is not there to be had — the two opt-ins are separate
 * switches and always were, so a board that enabled implementing and not the terminal must
 * go on implementing exactly as it did. Everything past that point is `runAgent`'s to fall
 * back from, which is why this returns null rather than refusing.
 *
 * **Which of the two kinds of tab it is, the operator's own command line decides.** A command
 * that says `-p` prints an answer and exits, so its prompt goes to stdin and ends there, and
 * the session is opened on pipes — a pseudoterminal has no end of file to give, see
 * `TerminalSessionOptions.input`. That is the configured command on this board and it is
 * unchanged in every particular: the process inside the tab is the process that ran before,
 * in the same checkout, reading the same prompt, and the only thing this ever added is that
 * its output goes somewhere a reader can see it while it is still happening.
 *
 * A command that does not say `-p` would start an interface if it were given a terminal, so
 * it is given one: the prompt travels as the command's last argument, stdin stays the
 * reader's, and the tab is something to answer rather than something to watch. Nothing is
 * appended to the command line and no second variable exists — the shape is read, exactly as
 * `streamsUsage()` reads it for the token counts. With no PTY binding to be had there is no
 * interface to draw either, so that run falls back to the paragraph above.
 */
function implementTerminalHost(workspace: Workspace, issueUrl: string): AgentHost | null {
  if (!terminalAvailable()) return null;

  return async ({ agentCommand, directory, prompt, onOutput }) => {
    let announce: (code: number | null) => void = () => { /* replaced below */ };
    const exited = new Promise<number | null>((resolve) => { announce = resolve; });

    // Loaded only for a command that could use one. A headless run took `null` here from the
    // day this existed, and asking for a binding it would then have to ignore would be a new
    // import on the path that must not change.
    const pty = runsHeadless(agentCommand) ? null : await loadPty();
    const started = await startTerminalSession(workspace, agentCommand, pty, {
      directory,
      owner: { agent: 'implement', issueUrl, label: issueTabLabel(issueUrl) },
      input: prompt,
      interactive: Boolean(pty)
    }, { onOutput, onExit: (code) => announce(code) });

    if (!started.ok) {
      logger.info(`${issueUrl} is being implemented without a tab: ${started.error}`);
      return null;
    }

    // On the record alone, like the token counts and for the same reason: it arrives in the
    // middle of a run, and writing it onto every element carrying the issue would bump a
    // version and broadcast an update for something no block with nothing selected can use.
    recordImplementTerminal(workspace.id, issueUrl, started.session.id);

    return {
      id: started.session.id,
      exited,
      close: () => started.session.close(),
      // Asked of the session rather than of the command a second time: what it actually got
      // is the answer, and a machine with no binary for its platform gets `pipe` from a
      // command line that reads interactive.
      interactive: started.session.mode === 'pty' && !started.session.readOnly
    };
  };
}

/** What the tab says: the issue, short enough to be a tab. */
function issueTabLabel(issueUrl: string): string {
  const number = /\/issues\/(\d+)/.exec(issueUrl)?.[1];
  return number ? `#${number}` : 'issue';
}

// A list, in the order the sessions were opened, each with its own transcript. Not "the
// session and its scrollback" any more: the singular was the shape of the old rule, and a
// caller that reads one field cannot tell a board with two tabs from a board with one.
app.get('/api/terminal', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;

  const sessions = terminalSessionsFor(workspaceIdFrom(req));
  res.json({
    success: true,
    limit: TERMINAL_SESSION_LIMIT,
    sessions: Array.from(sessions.values()).map((session) => ({
      ...session.summary(),
      scrollback: session.scrollback,
      sequence: session.sequence
    }))
  });
});

app.post('/api/terminal/input', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;
  const session = requireTerminal(req, res);
  if (!session) return;

  const data = typeof req.body?.data === 'string' ? req.body.data : '';
  if (!data) {
    return res.status(400).json({ success: false, error: 'Nothing to send: "data" must be a non-empty string.' });
  }

  // A session whose stdin was spent on a prompt has nothing for these bytes to reach, and
  // `write()` drops them. Answering 202 with a sequence number for a dropped keystroke is
  // reporting delivery that did not happen — every layer above then agrees the agent was
  // told something nobody told it. 409, like the cap: a conflict with what this session is,
  // not a request that failed.
  if (session.readOnly) {
    return res.status(409).json({
      success: false,
      readOnly: true,
      error: `Terminal session "${session.id}" is read-only: its stdin was spent on the `
        + 'prompt of the agent running in it, so there is nothing a keystroke can reach.'
    });
  }

  // 202 rather than 200: the shell has been handed the bytes, and what it does with them
  // comes back over the socket. Waiting here for output would be waiting for a prompt that
  // a piped shell never prints.
  res.status(202).json({ success: true, sequence: session.write(data) });
});

app.post('/api/terminal/resize', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;
  const session = requireTerminal(req, res);
  if (!session) return;

  const cols = Number(req.body?.cols);
  const rows = Number(req.body?.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
    return res.status(400).json({ success: false, error: 'cols and rows must both be positive numbers.' });
  }

  session.resize(Math.floor(cols), Math.floor(rows));
  broadcast({
    type: 'terminal_resized',
    sessionId: session.id,
    cols: Math.floor(cols),
    rows: Math.floor(rows)
  } as WebSocketMessage, workspaceIdFrom(req));
  res.json({ success: true, session: session.summary() });
});

app.delete('/api/terminal', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;
  const session = requireTerminal(req, res);
  if (!session) return;

  session.close();
  // By id, not by board: closing one tab must leave the others running, and a delete keyed
  // on the workspace would take the whole strip with it.
  terminalSessionsFor(workspaceIdFrom(req)).delete(session.id);
  res.json({ success: true, closed: true, sessionId: session.id });
});

/**
 * Nothing outlives the server.
 *
 * A shell is a process, and a process whose parent has gone is a process nobody can stop
 * from the board any more — the same shape as the constraint `docs/issue-block.md` records
 * about a reset: nothing here can reach into a process the server no longer owns. So the
 * sessions are closed on the way out rather than left to be inherited.
 */
function closeAllTerminals(): void {
  for (const sessions of terminalSessions.values()) {
    for (const session of sessions.values()) session.close();
  }
  terminalSessions.clear();
}

// On `exit` alone, and not on SIGTERM or SIGINT. Importing this module must not start the
// server — `isMainModule` at the bottom of the file is that rule — and a signal handler
// registered here would be registered by an importer too, which in Node means Ctrl+C stops
// terminating that process. `exit` has no such effect, it fires on the way out of the
// shutdown path the signals already have, and `close()` is synchronous, which is what an
// exit handler needs.
process.on('exit', closeAllTerminals);

// ─── Docs API (markdown shown for the selected element) ───────
//
// A shape can carry `customData.docKey`; this serves the matching markdown so the
// canvas can show the reasoning behind a box without leaving the drawing. Disabled
// until EXCALIDRAW_DOCS_DIR points somewhere, because serving arbitrary files from
// an unauthenticated local API is not something to enable by default.
const DOCS_DIR = process.env.EXCALIDRAW_DOCS_DIR
  ? path.resolve(process.env.EXCALIDRAW_DOCS_DIR)
  : null;

/**
 * The documentation shipped with the tool, rather than with the project on screen.
 *
 * `__dirname` is `dist/` once compiled, so this is the repository's own `docs/`.
 */
const TOOL_DOCS_DIR = path.resolve(__dirname, '../docs');

/**
 * Doc keys that belong to a block this server draws, not to the board it is drawn on.
 *
 * The mirror is generated onto every project that names a `githubProject`, always carrying
 * `docKey: "project-board"` — a key that resolved inside the mirrored project, where the
 * document has no reason to exist. A tool block's documentation is a property of the tool,
 * so these resolve against the tool's own directory whatever board is asking.
 */
const TOOL_DOC_KEYS = new Set<string>([MIRROR_DOC_KEY]);

// Keys become filenames, so anything that could climb out of DOCS_DIR is rejected
// outright rather than normalised — a rejected key is obvious, a rewritten one is not.
const DOC_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Why a doc could not be served, in a form a caller can branch on.
 *
 * The two 404s are different problems with different repairs — a board one setting away
 * from working, and a document nobody has written — and the panel used to map both to
 * "no document yet", which pointed the reader at the wrong one. The prose stays for
 * anything reading the API by hand; the code is what the panel switches on.
 */
const NO_DOCS_DIR = 'no-docs-dir';
const NO_DOC = 'no-doc';

app.get('/api/docs/:key', async (req: Request, res: Response) => {
  const key = req.params.key ?? '';
  if (!DOC_KEY_PATTERN.test(key) || key.includes('..')) {
    return res.status(400).json({ success: false, error: 'Invalid doc key' });
  }

  // Each board reads its own project's docs. The env var stays as the fallback for
  // single-board setups, which have no registry to resolve a directory from.
  const workspaceId = workspaceIdFrom(req);
  let docsDir = DOCS_DIR;
  if (TOOL_DOC_KEYS.has(key)) {
    docsDir = TOOL_DOCS_DIR;
  } else if (workspaceId !== DEFAULT_WORKSPACE_ID) {
    const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace?.docsDir) docsDir = path.resolve(workspace.docsDir);
  }

  if (!docsDir) {
    return res.status(404).json({
      success: false,
      code: NO_DOCS_DIR,
      error: 'No docs directory for this board. Set docsDir in board.config.json, or EXCALIDRAW_DOCS_DIR.'
    });
  }

  const filePath = path.resolve(docsDir, `${key}.md`);
  // Defence in depth: even with the pattern above, confirm we stayed inside the root.
  if (filePath !== docsDir && !filePath.startsWith(docsDir + path.sep)) {
    return res.status(400).json({ success: false, error: 'Invalid doc key' });
  }

  try {
    const markdown = await fs.readFile(filePath, 'utf-8');
    res.json({ success: true, key, workspace: workspaceId, markdown });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return res.status(404).json({ success: false, code: NO_DOC, error: `No doc for key "${key}"` });
    }
    logger.error(`Failed to read doc "${key}":`, error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Files API (for image elements) ───────────────────────────

/**
 * The files one board's elements actually point at.
 *
 * The store itself is not per-board — a file is content-addressed by id and two boards may
 * legitimately reference the same one — so the scoping is by reference rather than by
 * ownership: the ids that the workspace's own image elements and issue blocks name. What
 * this replaces is `GET /api/files` handing back every dataURL the process holds for every
 * board, which on a board full of screenshots is megabytes fetched to draw a canvas that
 * needed none of them.
 */
function filesForWorkspace(workspaceId: string): Record<string, ExcalidrawFile> {
  const wanted = new Set<string>();
  for (const element of elementsFor(workspaceId).values()) {
    const fileId = (element as { fileId?: unknown }).fileId;
    if (typeof fileId === 'string' && fileId) wanted.add(fileId);
    for (const id of issueImageIds(element.customData)) wanted.add(id);
  }
  const scoped: Record<string, ExcalidrawFile> = {};
  for (const id of wanted) {
    const file = files.get(id);
    if (file) scoped[id] = file;
  }
  return scoped;
}

// GET the files this board's elements reference
app.get('/api/files', (req: Request, res: Response) => {
  res.json({ files: filesForWorkspace(workspaceIdFrom(req)) });
});

/**
 * One file by id.
 *
 * `GET /api/files` returns every dataURL the process holds, which is the wrong request
 * for a panel that wants to show the two images a block has attached — on a board full
 * of screenshots that is megabytes to render a thumbnail.
 */
app.get('/api/files/:id', (req: Request, res: Response) => {
  const file = files.get(req.params.id as string);
  if (!file) {
    return res.status(404).json({ success: false, error: `File with ID ${req.params.id} not found` });
  }
  res.json({ success: true, file });
});

// POST add/update files (batch)
app.post('/api/files', (req: Request, res: Response) => {
  const body = req.body;
  const fileList: ExcalidrawFile[] = Array.isArray(body) ? body : (body?.files || []);
  for (const f of fileList) {
    if (f.id && f.dataURL) {
      files.set(f.id, { id: f.id, dataURL: f.dataURL, mimeType: f.mimeType || 'image/png', created: f.created || Date.now() });
    }
  }
  // Broadcast files to connected clients
  broadcast({ type: 'files_added', files: fileList });
  res.json({ success: true, count: fileList.length });
});

// DELETE a file
app.delete('/api/files/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  if (files.delete(id)) {
    broadcast({ type: 'file_deleted', fileId: id });
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: `File with ID ${id} not found` });
  }
});

// Image export: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingExport {
  resolve: (data: { format: string; data: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  collectionTimeout: ReturnType<typeof setTimeout> | null;
  bestResult: { format: string; data: string } | null;
}
const pendingExports = new Map<string, PendingExport>();

app.post('/api/export/image', (req: Request, res: Response) => {
  try {
    const { format, background } = req.body;

    if (!format || !['png', 'svg'].includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'format must be "png" or "svg"'
      });
    }

    // The board being exported, resolved before the guard: what has to be open in a browser
    // is *this* board, not any board at all. A tab on another project cannot render it, and
    // letting it try is how an export of one board came back with another board's scene.
    const exportWorkspaceId = workspaceIdFrom(req);

    if (clientsWatching(exportWorkspaceId) === 0) {
      return res.status(503).json({
        success: false,
        error: `No frontend client is on the board "${exportWorkspaceId}". Open it in a browser first.`
      });
    }

    const requestId = generateId();

    const exportPromise = new Promise<{ format: string; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingExports.get(requestId);
        pendingExports.delete(requestId);
        // If we collected any result during the window, use it
        if (pending?.bestResult) {
          resolve(pending.bestResult);
        } else {
          reject(new Error('Export timed out after 30 seconds'));
        }
      }, 30000);

      pendingExports.set(requestId, { resolve, reject, timeout, collectionTimeout: null, bestResult: null });
    });

    // Re-broadcast current elements so all connected clients (including stale ones)
    // sync to the canonical server state before exporting
    const filesObj = filesForWorkspace(exportWorkspaceId);
    broadcast({
      type: 'initial_elements',
      elements: Array.from(elementsFor(exportWorkspaceId).values()),
      ...(Object.keys(filesObj).length > 0 ? { files: filesObj } : {})
    } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> }, exportWorkspaceId);

    // Give browsers time to process the reload before requesting export
    setTimeout(() => {
      broadcast({
        type: 'export_image_request',
        requestId,
        format,
        background: background ?? true
      }, exportWorkspaceId);
    }, 800);

    exportPromise
      .then(result => {
        res.json({
          success: true,
          format: result.format,
          data: result.data
        });
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating image export:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Image export: result (Frontend -> Express -> MCP)
app.post('/api/export/image/result', (req: Request, res: Response) => {
  try {
    const { requestId, format, data, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingExports.get(requestId);
    if (!pending) {
      // Already resolved by another client, or expired — ignore silently
      return res.json({ success: true });
    }

    if (error) {
      // Don't reject on error — another WebSocket client may still succeed.
      logger.warn(`Export error from one client (requestId=${requestId}): ${error}`);
      return res.json({ success: true });
    }

    // Keep the largest response (most complete canvas state wins)
    if (!pending.bestResult || data.length > pending.bestResult.data.length) {
      pending.bestResult = { format, data };
    }

    // Start a short collection window on the first response, then resolve with best
    if (!pending.collectionTimeout) {
      pending.collectionTimeout = setTimeout(() => {
        const p = pendingExports.get(requestId);
        if (p?.bestResult) {
          clearTimeout(p.timeout);
          pendingExports.delete(requestId);
          p.resolve(p.bestResult);
        }
      }, 3000);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing export result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Viewport control: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingViewport {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingViewports = new Map<string, PendingViewport>();

const viewportRequestSchema = z.object({
  scrollToContent: z.boolean().optional(),
  scrollToElementIds: z.array(z.string().min(1)).min(1).optional(),
  viewportZoomFactor: z.number().positive().max(1).optional(),
  scrollToElementId: z.string().min(1).optional(),
  zoom: z.number().min(0.1).max(10).optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional()
}).superRefine((params, ctx) => {
  const modes = [
    params.scrollToContent === true,
    params.scrollToElementIds !== undefined,
    params.scrollToElementId !== undefined,
    params.zoom !== undefined || params.offsetX !== undefined || params.offsetY !== undefined
  ].filter(Boolean).length;

  if (modes !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Specify exactly one viewport mode: scrollToContent, scrollToElementIds, scrollToElementId, or manual zoom/offset'
    });
  }
  if (params.viewportZoomFactor !== undefined &&
      params.scrollToContent !== true &&
      params.scrollToElementIds === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['viewportZoomFactor'],
      message: 'viewportZoomFactor requires scrollToContent or scrollToElementIds'
    });
  }
});

app.post('/api/viewport', (req: Request, res: Response) => {
  try {
    const {
      scrollToContent,
      scrollToElementIds,
      scrollToElementId,
      viewportZoomFactor,
      zoom,
      offsetX,
      offsetY
    } = viewportRequestSchema.parse(req.body);

    // The board whose camera is being moved. Sent to everyone, this was the one path that
    // reached across browser windows: an agent scrolling its own project board scrolled
    // every board anybody had open (#156).
    const viewportWorkspaceId = workspaceIdFrom(req);

    if (clientsWatching(viewportWorkspaceId) === 0) {
      return res.status(503).json({
        success: false,
        error: `No frontend client is on the board "${viewportWorkspaceId}". Open it in a browser first.`
      });
    }

    const requestId = generateId();

    const viewportPromise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingViewports.delete(requestId);
        reject(new Error('Viewport request timed out after 10 seconds'));
      }, 10000);

      pendingViewports.set(requestId, { resolve, reject, timeout });
    });

    broadcast({
      type: 'set_viewport',
      requestId,
      scrollToContent,
      scrollToElementIds,
      scrollToElementId,
      viewportZoomFactor,
      zoom,
      offsetX,
      offsetY
    }, viewportWorkspaceId);

    viewportPromise
      .then(result => {
        res.json(result);
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating viewport change:', error);
    res.status(error instanceof z.ZodError ? 400 : 500).json({
      success: false,
      error: error instanceof z.ZodError
        ? error.issues.map(issue => issue.message).join('; ')
        : (error as Error).message
    });
  }
});

// Viewport control: result (Frontend -> Express -> MCP)
app.post('/api/viewport/result', (req: Request, res: Response) => {
  try {
    const { requestId, success, message, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingViewports.get(requestId);
    if (!pending) {
      return res.json({ success: true });
    }

    if (error || success === false) {
      clearTimeout(pending.timeout);
      pendingViewports.delete(requestId);
      pending.reject(new Error(error || message || 'Viewport update failed'));
      return res.json({ success: true });
    }

    clearTimeout(pending.timeout);
    pendingViewports.delete(requestId);
    pending.resolve({ success: true, message: message || 'Viewport updated' });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing viewport result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: save
app.post('/api/snapshots', (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Snapshot name is required'
      });
    }

    const snapshot: Snapshot = {
      name,
      elements: Array.from(elementsFor(workspaceIdFrom(req)).values()),
      createdAt: new Date().toISOString()
    };

    snapshots.set(name, snapshot);
    logger.info(`Snapshot saved: "${name}" with ${snapshot.elements.length} elements`);

    res.json({
      success: true,
      name,
      elementCount: snapshot.elements.length,
      createdAt: snapshot.createdAt
    });
  } catch (error) {
    logger.error('Error saving snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: list
app.get('/api/snapshots', (req: Request, res: Response) => {
  try {
    const list = Array.from(snapshots.values()).map(s => ({
      name: s.name,
      elementCount: s.elements.length,
      createdAt: s.createdAt
    }));

    res.json({
      success: true,
      snapshots: list,
      count: list.length
    });
  } catch (error) {
    logger.error('Error listing snapshots:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: get by name
app.get('/api/snapshots/:name', (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const snapshot = snapshots.get(name!);

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: `Snapshot "${name}" not found`
      });
    }

    res.json({
      success: true,
      snapshot
    });
  } catch (error) {
    logger.error('Error fetching snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Serve the frontend
app.get('/', (req: Request, res: Response) => {
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
  res.sendFile(htmlFile, (err) => {
    if (err) {
      logger.error('Error serving frontend:', err);
      res.status(404).send('Frontend not found. Please run "npm run build" first.');
    }
  });
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    elements_count: totalElementCount(),
    websocket_clients: clients.size,
    // Identity for `stop`: it must only ever signal a process that both
    // identifies as this service AND self-reports its pid — never a pid
    // from a stale pidfile or an unrelated app squatting on the port.
    service: 'mcp-excalidraw-canvas',
    pid: process.pid,
    // What kind of canvas this is, which `status` cannot say. A server auto-started by
    // `ensureCanvasRunning` inherits whatever environment its caller held, and an MCP server
    // started by an editor holds no `EXCALIDRAW_*` at all — so a stand-in binds the board's
    // port with no registry, no terminal and no agents, and answers everything above exactly
    // as the board it replaced did. Telling the two apart took three more requests. These
    // fields are the difference, and they are read from the same expressions the routes
    // themselves are gated on, so they cannot drift from what the instance actually does.
    workspaces: process.env.EXCALIDRAW_WORKSPACES ? 'configured' : 'none',
    terminal: Boolean(TERMINAL_SETTING),
    // The agents fail the most quietly of the three: the routes answer, the blocks draw, the
    // buttons are there, and pressing one does nothing. **Two booleans, never one** — the
    // variables are separate so that turning on issue blocks cannot quietly turn on repository
    // writes, and a single flag here would hide the very asymmetry that split exists for.
    // Whether they are set, never what they are: these are somebody's command lines, with
    // paths and flags in them, and this route is unauthenticated on loopback.
    agents: {
      issue: ISSUE_AGENT_CONFIGURED,
      implement: IMPLEMENT_AGENT_CONFIGURED
    }
  });
});

// Sync status endpoint
app.get('/api/sync/status', (req: Request, res: Response) => {
  res.json({
    success: true,
    elementCount: totalElementCount(),
    workspaces: activeWorkspaceIds().length,
    timestamp: new Date().toISOString(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024), // MB
    },
    websocketClients: clients.size
  });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_GUARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (isOpen: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(isOpen);
    };

    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function findExistingLoopbackListener(port: number): Promise<string | null> {
  for (const host of LOOPBACK_ADDRESSES) {
    if (await canConnect(host, port)) {
      return host;
    }
  }
  return null;
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    const address = (error as NodeJS.ErrnoException & { address?: string }).address || HOST;
    logger.error(`Canvas server port ${PORT} is already in use on ${formatHostForUrl(address)}.`);
  } else if (error.code === 'EACCES') {
    logger.error(`Canvas server cannot bind ${formatHostForUrl(HOST)}:${PORT}: permission denied.`);
  } else {
    logger.error('Failed to start canvas server:', error);
  }
  process.exit(1);
});

async function startServer(): Promise<void> {
  if (LOOPBACK_GUARD_HOSTS.has(HOST)) {
    const existingHost = await findExistingLoopbackListener(PORT);
    if (existingHost) {
      logger.error(
        `Refusing to start canvas server on ${formatHostForUrl(HOST)}:${PORT}: ` +
        `${formatHostForUrl(existingHost)}:${PORT} is already listening. ` +
        'This prevents duplicate IPv4/IPv6 canvas servers from splitting state.'
      );
      process.exit(1);
    }
  }

  // Only the process that actually wrote the pidfile may remove it —
  // a concurrent-start loser exiting on EADDRINUSE must not delete the
  // winner's pidfile.
  let ownsPidFile = false;

  server.listen(PORT, HOST, () => {
    const hostForUrl = formatHostForUrl(HOST);
    logger.info(`POC server running on http://${hostForUrl}:${PORT}`);
    logger.info(`WebSocket server running on ws://${hostForUrl}:${PORT}`);

    // Written only after listen succeeds so stale files can't shadow a
    // server that never came up; lets `excalidraw-canvas stop` find us.
    writePidFile(PORT, process.pid);
    ownsPidFile = true;

    // The boards, and then whatever the last process was in the middle of when it stopped.
    // Started here rather than before `listen` so neither a slow read nor a slow git can
    // delay the board coming up, and deliberately not awaited: nothing else depends on
    // either having finished.
    //
    // In that order, because recovery writes what it derives from git onto the elements
    // carrying the issue, and it can only write onto elements that are in the store when it
    // looks. The other order leaves a recovered `interrupted` run recorded but undrawn.
    void seedBoardsFromFiles().then(recoverInterruptedRuns);
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info(`Received ${signal}, shutting down canvas server`);
    if (ownsPidFile) removePidFile(PORT);
    server.close(() => process.exit(0));
    // Force-exit if open sockets keep the server from closing promptly
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('exit', () => {
    if (ownsPidFile) removePidFile(PORT);
  });
}

// Start the canvas server only when this file is the process entry point
// (`node dist/server.js`, `npm run canvas`, or spawned by the CLI/MCP
// auto-start). Importing this module must never start the server.
if (isMainModule(import.meta.url)) {
  void startServer();
}

export { startServer };
export default app;
