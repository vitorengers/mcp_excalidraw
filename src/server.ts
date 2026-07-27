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
  readWorkspaceConfig,
  writeWorkspaceConfig,
  Workspace
} from './core/workspaces.js';
import { listDirectories } from './core/directory-browse.js';
import { runIssueAgent } from './core/issue-agent.js';
import { issueImageIds, materializeIssueImages, MaterializedImages, NO_IMAGES } from './core/issue-images.js';
import {
  readProjectBoard,
  moveCard,
  moveIssueToColumn,
  inProgressColumn,
  todoColumn,
  NoProjectConfigured,
  NotOnThisBoard
} from './core/project-board.js';
import { commentOnIssue, fetchIssue, isIssueUrl } from './core/github-issue.js';
import type { IssueDetail } from './core/github-issue.js';
import { IssueMemo, memoWindow } from './core/issue-memo.js';
import { TerminalSession, loadPty, shellCommandFrom } from './core/terminal-session.js';
import { issueBlockAppearance } from './core/issue-appearance.js';
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
  ImplementWorktree,
  ensureWorktree,
  releaseWorktree
} from './core/implement-worktree.js';
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
 * Broadcast to the clients watching one workspace.
 *
 * Omitting `workspaceId` reaches every client — right for server-wide notices, wrong
 * for element events, which would make one board redraw with another board's shapes.
 */
function broadcast(message: WebSocketMessage, workspaceId?: string): void {
  const data = JSON.stringify(
    workspaceId ? { ...message, workspace: workspaceId } : message
  );
  clients.forEach(client => {
    try {
      if (client.readyState !== WebSocket.OPEN) return;
      if (workspaceId && socketWorkspaces.get(client) !== workspaceId) return;
      client.send(data);
    } catch (err) {
      logger.warn('Failed to send to client, removing');
      clients.delete(client);
    }
  });
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
  // back, a second window — so the transcript is replayed here rather than being lost with
  // whichever socket happened to receive it. Sent only when there is a session: a board with
  // none must not be told about a feature that is switched off.
  const terminal = terminalSessions.get(workspaceId);
  if (terminal) {
    ws.send(JSON.stringify({
      type: 'terminal_session',
      workspace: workspaceId,
      session: terminal.summary(),
      scrollback: terminal.scrollback,
      sequence: terminal.sequence
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
    } catch {
      // Clients talk to this server over HTTP; anything else arriving here is not ours.
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    socketWorkspaces.delete(ws);
    logger.info('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    clients.delete(ws);
    socketWorkspaces.delete(ws);
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

    // Broadcast to all connected clients
    const message: ElementUpdatedMessage = {
      type: 'element_updated',
      element: updatedElement
    };
    broadcast(message, workspaceId);

    // Moving/resizing a shape must drag its bound arrows along
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

        // Add server metadata. Note version comes from the incoming element: it is
        // what makes the next reconciliation possible, so it must not be reset.
        const processedElement: ServerElement = {
          ...element,
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
      `${deletedCount} deleted, ${staleCount} ignored as stale, ${store.size} total`
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
const ISSUE_AGENT_COMMAND = process.env.EXCALIDRAW_ISSUE_AGENT || null;

/** Elements with a run in flight. A second click must not open a second issue. */
const issueRunsInFlight = new Set<string>();

app.post('/api/issue-block/:id', async (req: Request, res: Response) => {
  const elementId = req.params.id ?? '';

  if (!ISSUE_AGENT_COMMAND) {
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
  if (issueRunsInFlight.has(elementId)) {
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

  issueRunsInFlight.add(elementId);
  /**
   * Write the state onto the block, and the look that goes with it.
   *
   * Here rather than in the browser because this is where the state is authored: the
   * appearance then persists, exports and reaches every connected tab through the update
   * that already carries the state. A browser deriving it on render would have to derive it
   * again on every path that draws a block, and a block saved to `docs/board.excalidraw`
   * would go back to looking like a draft.
   */
  const markState = (state: string, extra: Record<string, unknown> = {}) => {
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
  };

  markState('running');
  // Answer immediately: an investigation takes minutes, and a request held open that
  // long looks indistinguishable from a hang. Progress arrives over the socket.
  res.status(202).json({ success: true, state: 'running', elementId });

  /**
   * Record the title of the issue the run produced.
   *
   * Only the title is written, not the label: wrapping text to a box and refitting the
   * box needs font metrics, and the server has none. Writing the label here produced a
   * 518px title inside a 400px block, on one line, in a box still sized for the
   * observation. The browser owns geometry — it reads `issueTitle` and relays the block
   * itself.
   *
   * The observation is kept rather than discarded: it is the wording that produced this
   * particular issue, and the panel still shows it.
   *
   * Best-effort by design: the issue is already created by the time this runs, so a
   * failure here must not turn a successful run into a failed block.
   */
  const adoptIssueTitle = async (issueUrl: string): Promise<void> => {
    const detail = await fetchIssue(workspace, issueUrl);
    if (!detail.title) return;

    markState('created', { issueUrl, issueError: null, issueTitle: detail.title, observation });

    const label = store.get(boundText?.id ?? '');
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
  };

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
      agentCommand: ISSUE_AGENT_COMMAND,
      imagePaths: images.paths
    });
    if (result.ok && result.issueUrl) {
      markState('created', { issueUrl: result.issueUrl, issueError: null, observation });
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
        await adoptIssueTitle(result.issueUrl);
      } catch (error) {
        logger.warn(`Issue block ${elementId}: could not read back the issue — ${(error as Error).message}`);
      }
    } else {
      markState('failed', { issueError: result.error });
      logger.warn(`Issue block ${elementId} failed: ${result.error}`);
    }
  } catch (error) {
    markState('failed', { issueError: (error as Error).message });
  } finally {
    await images.cleanup();
    issueRunsInFlight.delete(elementId);
  }
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
 * process*, which is the case that matters: `issueRunsInFlight` is in memory, so after a
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

  if (issueRunsInFlight.has(elementId)) {
    return res.status(409).json({
      success: false,
      error: 'A run is in flight for this block right now. Resetting would only hide it.'
    });
  }

  const { issueState, issueError, ...rest } = (element.customData ?? {}) as Record<string, unknown>;
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
// issue blocks must not quietly enable repository writes.
const IMPLEMENT_AGENT_COMMAND = process.env.EXCALIDRAW_IMPLEMENT_AGENT || null;

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
): Pick<ImplementRecord, 'startedAt' | 'usage'> {
  const existing = readImplement(workspaceId, issueUrl);
  return { startedAt: existing?.startedAt ?? null, usage: existing?.usage ?? null };
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
 * Start an implementation for one issue, however it was asked for.
 *
 * Both routes land here — the element one for an authored block, the URL one for a mirrored
 * card that has no element at all — so the guards are stated once and cannot drift apart.
 * Answers immediately and reports over the socket: implementing has no time limit, so a
 * held-open request would only look like a hang.
 */
async function beginImplement(res: Response, workspaceId: string, issueUrl: string): Promise<void> {
  if (!isIssueUrl(issueUrl)) {
    res.status(400).json({ success: false, error: `Not a GitHub issue URL: ${issueUrl}` });
    return;
  }

  const existing = readImplement(workspaceId, issueUrl);
  if (existing?.state === 'running') {
    res.status(409).json({ success: false, error: 'An implementation is already in flight for this issue.' });
    return;
  }
  if (existing?.state === 'done' && existing.url) {
    // The same reasoning that stops one observation becoming two issues.
    res.status(409).json({
      success: false,
      error: 'This issue already has an implementation.',
      implementUrl: existing.url
    });
    return;
  }

  // Different issues no longer collide, so this is a budget rather than a safety guard —
  // but a board that can start runs faster than a machine can finish them still needs one,
  // and a refusal has to say which run is holding the slot to be worth reading.
  const inFlight = runningImplements(workspaceId);
  if (IMPLEMENT_CONCURRENCY > 0 && inFlight.length >= IMPLEMENT_CONCURRENCY) {
    res.status(409).json({
      success: false,
      error: `This workspace already has ${inFlight.length} implementation(s) running, which is the limit `
        + `set by EXCALIDRAW_IMPLEMENT_CONCURRENCY. In flight: ${inFlight.map((run) => run.issueUrl).join(', ')}`,
      running: inFlight.map((run) => run.issueUrl)
    });
    return;
  }

  const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    res.status(400).json({
      success: false,
      error: `Workspace "${workspaceId}" is not registered, so there is no project to work in.`
    });
    return;
  }
  if (workspace.error) {
    res.status(400).json({ success: false, error: `Workspace is unusable: ${workspace.error}` });
    return;
  }

  // The one write of the start time. Everything after it carries this instant forward, and
  // everything showing a duration subtracts from it rather than being told a duration.
  recordImplement(workspaceId, issueUrl, {
    state: 'running',
    url: null,
    error: null,
    worktree: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    usage: null
  });
  res.status(202).json({ success: true, state: 'running', issueUrl });

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

    const result = await runImplementAgent(workspace, issueUrl, {
      agentCommand: IMPLEMENT_AGENT_COMMAND as string,
      worktree,
      // Reached only when the configured command already streams. Otherwise the agent
      // prints prose at exit, there is nothing to read, and this is never called.
      onUsage: (usage) => recordImplementUsage(workspaceId, issueUrl, usage)
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

/** The agent writes to the repository, so every entrance carries the same two guards. */
function implementingRefused(res: Response): boolean {
  if (!IMPLEMENT_AGENT_COMMAND) {
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

  await beginImplement(res, workspaceId, issueUrl);
});

/**
 * The same thing, for a shape the server has never seen.
 *
 * A mirrored card is drawn from GitHub and never synced, so there is no element id to name
 * it by — but there is an issue, and the issue is what is being implemented.
 */
app.post('/api/implement', async (req: Request, res: Response) => {
  if (implementingRefused(res)) return;

  const issueUrl = typeof req.body?.url === 'string' ? req.body.url : '';
  if (!issueUrl) {
    return res.status(400).json({ success: false, error: 'No issue URL was given.' });
  }

  await beginImplement(res, workspaceIdFrom(req), issueUrl);
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
 */
app.get('/api/implement', (req: Request, res: Response) => {
  const workspaceId = workspaceIdFrom(req);
  const issueUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!issueUrl) {
    return res.json({
      success: true,
      runs: listImplement(workspaceId),
      concurrency: IMPLEMENT_CONCURRENCY
    });
  }
  res.json({ success: true, implement: readImplement(workspaceId, issueUrl) });
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
// exactly: opt in by environment variable, loopback only, one session per workspace.
//
// `EXCALIDRAW_TERMINAL` unset means these routes do not exist. Not "answer 403", not
// "answer with an empty session": 404, the same shape the issue block uses, so a canvas
// that never turned it on cannot tell a disabled feature from an absent one.
const TERMINAL_SETTING = process.env.EXCALIDRAW_TERMINAL || null;

/** One session per board, which is what makes a second request a conflict. */
const terminalSessions = new Map<string, TerminalSession>();

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

/** The session for a board, or a 404 saying there is none. */
function requireTerminal(req: Request, res: Response): TerminalSession | null {
  const workspaceId = workspaceIdFrom(req);
  const session = terminalSessions.get(workspaceId);
  if (!session) {
    res.status(404).json({ success: false, error: 'No terminal session is open for this board.' });
    return null;
  }
  return session;
}

app.post('/api/terminal', async (req: Request, res: Response) => {
  if (terminalRefused(res)) return;

  const workspaceId = workspaceIdFrom(req);
  const existing = terminalSessions.get(workspaceId);
  if (existing) {
    // 409 rather than a second shell: two shells in one repository is the collision the
    // implement agent's worktrees exist to avoid, and here nobody asked for a second one.
    return res.status(409).json({
      success: false,
      error: 'A terminal session is already open for this board.',
      session: existing.summary()
    });
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

  // Which mode this session will be in has to be settled before the shell is named: the
  // default shell is spelled differently for each. PowerShell's `-Command -` refuses to
  // start at all when stdin is a terminal, so a PTY session asks for the plain REPL.
  const pty = await loadPty();
  const shellCommand = shellCommandFrom(TERMINAL_SETTING, workspace, pty ? 'pty' : 'pipe');
  if (!shellCommand) {
    return res.status(404).json({
      success: false,
      error: 'The terminal is disabled. Set EXCALIDRAW_TERMINAL to enable it.'
    });
  }

  let session: TerminalSession;
  try {
    session = new TerminalSession(workspace, shellCommand, {
      onOutput: (data, sequence) => {
        broadcast({ type: 'terminal_output', data, sequence } as WebSocketMessage, workspaceId);
      },
      onExit: (code) => {
        // Dropped from the map here rather than on the DELETE, because a shell that ended
        // on its own — `exit`, or a crash — has to free the slot too. Only if it is still
        // the current one: a session opened after this one exited must not be evicted by
        // its predecessor's event.
        if (terminalSessions.get(workspaceId) === session) terminalSessions.delete(workspaceId);
        broadcast({ type: 'terminal_exit', code } as WebSocketMessage, workspaceId);
      }
    }, pty);
  } catch (error) {
    logger.error('Could not start a terminal:', error);
    return res.status(500).json({ success: false, error: (error as Error).message });
  }

  // A ConPTY reports no process id until its console host has connected, and a session
  // announced before then would carry a 0 into the block and into `taskkill` on the way out.
  await session.started;

  terminalSessions.set(workspaceId, session);
  broadcast({
    type: 'terminal_session',
    session: session.summary(),
    scrollback: session.scrollback,
    sequence: session.sequence
  } as WebSocketMessage, workspaceId);

  // 202, like starting an agent: the shell is running, and what it produces arrives over
  // the socket rather than in this response.
  res.status(202).json({ success: true, session: session.summary() });
});

app.get('/api/terminal', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;

  const session = terminalSessions.get(workspaceIdFrom(req));
  res.json({
    success: true,
    session: session ? session.summary() : null,
    scrollback: session?.scrollback ?? '',
    sequence: session?.sequence ?? 0
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
    cols: Math.floor(cols),
    rows: Math.floor(rows)
  } as WebSocketMessage, workspaceIdFrom(req));
  res.json({ success: true, session: session.summary() });
});

app.delete('/api/terminal', (req: Request, res: Response) => {
  if (terminalRefused(res)) return;
  const session = requireTerminal(req, res);
  if (!session) return;

  const workspaceId = workspaceIdFrom(req);
  session.close();
  terminalSessions.delete(workspaceId);
  res.json({ success: true, closed: true });
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
  for (const session of terminalSessions.values()) session.close();
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

// Keys become filenames, so anything that could climb out of DOCS_DIR is rejected
// outright rather than normalised — a rejected key is obvious, a rewritten one is not.
const DOC_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

app.get('/api/docs/:key', async (req: Request, res: Response) => {
  const key = req.params.key ?? '';
  if (!DOC_KEY_PATTERN.test(key) || key.includes('..')) {
    return res.status(400).json({ success: false, error: 'Invalid doc key' });
  }

  // Each board reads its own project's docs. The env var stays as the fallback for
  // single-board setups, which have no registry to resolve a directory from.
  const workspaceId = workspaceIdFrom(req);
  let docsDir = DOCS_DIR;
  if (workspaceId !== DEFAULT_WORKSPACE_ID) {
    const workspaces = await loadWorkspaces(process.env.EXCALIDRAW_WORKSPACES);
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace?.docsDir) docsDir = path.resolve(workspace.docsDir);
  }

  if (!docsDir) {
    return res.status(404).json({
      success: false,
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
      return res.status(404).json({ success: false, error: `No doc for key "${key}"` });
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

    if (clients.size === 0) {
      return res.status(503).json({
        success: false,
        error: 'No frontend client connected. Open the canvas in a browser first.'
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
    const exportWorkspaceId = workspaceIdFrom(req);
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
      });
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

    if (clients.size === 0) {
      return res.status(503).json({
        success: false,
        error: 'No frontend client connected. Open the canvas in a browser first.'
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
    });

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
    pid: process.pid
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
