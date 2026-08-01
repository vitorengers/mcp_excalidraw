import logger from '../utils/logger.js';
import { ServerElement } from '../types.js';
import { EXPRESS_SERVER_URL, ENABLE_CANVAS_SYNC } from './config.js';
import { CANVAS_SERVICE_NAME, isAcceptedCanvasService } from './identity.js';
import { env, settingName } from './settings.js';
// The board token, read off disk per request. Fresh every time rather than captured: an MCP
// server outlives several starts of the canvas it drives, and a token cached at import would be
// the previous one's. A file read of sixty-four bytes against a request that is about to cross a
// socket is not a cost worth a cache.
import { authHeaders } from './auth-token.js';
import { AsyncLocalStorage } from 'async_hooks';
// Type only: this module is on the CLI's own startup path, and the preflight reaches the
// agent module and its spawns. What is wanted here is the shape of a payload, not the code.
import type { AgentsHealth } from './agent-preflight.js';

// API Response types
export interface ApiResponse {
  success: boolean;
  element?: ServerElement;
  elements?: ServerElement[];
  message?: string;
  error?: string;
  count?: number;
}

export interface SyncResponse {
  element?: ServerElement;
  elements?: ServerElement[];
}

// ---- Which board a request is about ----
//
// Every request this module sends used to carry no `?workspace=` at all, and a request that
// names none resolves to the `default` store (core/element-store.ts). So every CLI command and
// every MCP tool drew on the one board that is nobody's project, whatever the operator had
// registered — the product's headline claim, that agents draw on your project board, was
// reachable only by hand-written REST (#344).
//
// It is resolved here, once, and appended by `requestJson` — the same shape the frontend has
// always had in `apiUrl` (frontend/src/App.tsx). Doing it at each call site instead would be
// thirty places to forget, which is how this happened.

/** The scratch canvas: the board of somebody who has registered no project. */
export const DEFAULT_WORKSPACE = 'default';

/**
 * The board *one call* is about, for the MCP tools.
 *
 * An MCP server is long-lived and serves whichever board each tool call names, so the answer
 * cannot be a variable set at startup. It is carried on the async context instead, which is
 * what lets the thirty-odd client functions below stay unchanged: `src/index.ts` puts the
 * tool's `workspace` argument here and everything it reaches reads it.
 */
const calledOn = new AsyncLocalStorage<string>();

/** Run `work` against one named board. An empty name means "whatever the process resolves". */
export function onWorkspace<T>(id: string | undefined | null, work: () => Promise<T>): Promise<T> {
  const wanted = typeof id === 'string' ? id.trim() : '';
  return wanted ? calledOn.run(wanted, work) : work();
}

/** What said which board, in the order that wins: this call, then the environment. */
function namedWorkspace(): string | null {
  const perCall = calledOn.getStore();
  if (perCall) return perCall;
  const configured = env('WORKSPACE')?.trim();
  return configured || null;
}

/**
 * The projects the canvas has registered, asked of the canvas rather than read off disk.
 *
 * The server is the authority on this and the client frequently cannot be: an agent driving a
 * board from some other directory has no registry path and never will. A canvas that will not
 * answer — an older build, a listing refused — is `null` rather than an empty list, so that
 * "this board has no projects" and "this board did not say" stay different answers.
 *
 * Memoised for a few seconds, the way the identity probe below is and for the same reason: one
 * CLI command makes a burst of requests, and a long-lived MCP server must still notice a project
 * registered while it was running.
 */
const REGISTRY_TTL_MS = 3000;
let registeredIds: string[] | null = null;
let registeredAt = 0;
let registryProbe: Promise<string[] | null> | null = null;

async function registeredWorkspaceIds(): Promise<string[] | null> {
  if (registeredIds && Date.now() - registeredAt < REGISTRY_TTL_MS) return registeredIds;

  const probe = registryProbe ?? (registryProbe = (async () => {
    try {
      const response = await fetch(`${EXPRESS_SERVER_URL}/api/workspaces`, {
        headers: authHeaders(EXPRESS_SERVER_URL),
        signal: AbortSignal.timeout(2000)
      });
      if (!response.ok) return null;
      const body = await response.json() as { workspaces?: { id?: unknown }[] };
      if (!Array.isArray(body?.workspaces)) return null;
      registeredIds = body.workspaces
        .map((workspace) => (typeof workspace?.id === 'string' ? workspace.id.trim() : ''))
        .filter(Boolean);
      registeredAt = Date.now();
      return registeredIds;
    } catch {
      // Down, booting, or a build with no such route. Not knowing is not a refusal.
      return null;
    } finally {
      registryProbe = null;
    }
  })());
  return probe;
}

/** How a caller says which board, in the two spellings there are. */
function howToName(): string {
  return `Name one with --workspace <id>, with the ${settingName('WORKSPACE')} environment `
    + 'variable, or with the "workspace" argument on the MCP tool.';
}

function refusal(message: string, code: string): Error {
  const error = new Error(message);
  (error as any).code = code;
  return error;
}

/**
 * The board this request is for.
 *
 * The rule where nothing named one is the issue's own: exactly one registered project is that
 * project, several is a refusal that lists them, and none at all is still `default`. Guessing
 * among several is the failure being removed — an agent drawing on a board nobody can see is
 * worse than an agent that stops and asks which one.
 */
async function activeWorkspace(): Promise<string> {
  const wanted = namedWorkspace();
  const registered = await registeredWorkspaceIds();

  if (wanted) {
    // The scratch canvas is always addressable: it is a real board, and it is the one a caller
    // names precisely when they do *not* want a project.
    if (wanted === DEFAULT_WORKSPACE) return wanted;
    // A board that registered nothing, or would not say, has no list to be wrong about.
    if (!registered || registered.length === 0) return wanted;
    if (registered.includes(wanted)) return wanted;
    throw refusal(
      `No project called "${wanted}" is registered on this board. It has: ${registered.join(', ')}. `
      + 'A workspace nobody registered would be an invisible canvas with no tab and nothing '
      + 'saving it, so nothing was written.',
      'WORKSPACE_UNKNOWN'
    );
  }

  if (!registered || registered.length === 0) return DEFAULT_WORKSPACE;
  if (registered.length === 1) return registered[0]!;
  throw refusal(
    `This board has ${registered.length} projects registered — ${registered.join(', ')} — and `
    + `nothing said which one to draw on. ${howToName()}`,
    'WORKSPACE_AMBIGUOUS'
  );
}

/** An API path with the board appended, the way `apiUrl` does it in the frontend. */
async function boardPath(path: string): Promise<string> {
  const workspace = await activeWorkspace();
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}workspace=${encodeURIComponent(workspace)}`;
}

/**
 * A request init with this board's token on it.
 *
 * Every `/api` request from this process goes through here. Since #350 the canvas refuses one
 * that does not carry the token it wrote to the state directory at startup — which is what stops
 * *any other process on the machine* driving an API that spawns coding agents and real shells.
 * The caller's own headers win nothing and lose nothing: the token is added beside them.
 *
 * A board that wrote no token file — one started with the opt-out, or from a build older than
 * this one — yields no header and is driven exactly as before.
 */
function withCanvasAuth(init?: RequestInit): RequestInit {
  return { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...authHeaders(EXPRESS_SERVER_URL) } };
}

// Helper functions to sync with Express server (canvas)
export async function syncToCanvas(operation: string, data: any): Promise<SyncResponse | null> {
  if (!ENABLE_CANVAS_SYNC) {
    logger.debug('Canvas sync disabled, skipping');
    return null;
  }

  // Resolved before the try, deliberately: the catch below exists so that a canvas being *down*
  // degrades an MCP tool quietly, and a board that could not be chosen is not that. Swallowed, a
  // refusal would reach the caller as "HTTP server unavailable" for a server that is answering.
  const on = await boardPath('');

  try {
    let url: string;
    let options: any;

    switch (operation) {
      case 'create':
        url = `${EXPRESS_SERVER_URL}/api/elements${on}`;
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
        break;

      case 'update':
        url = `${EXPRESS_SERVER_URL}/api/elements/${data.id}${on}`;
        options = {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        };
        break;

      case 'delete':
        url = `${EXPRESS_SERVER_URL}/api/elements/${data.id}${on}`;
        options = { method: 'DELETE' };
        break;

      case 'batch_create':
        url = `${EXPRESS_SERVER_URL}/api/elements/batch${on}`;
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ elements: data })
        };
        break;

      default:
        logger.warn(`Unknown sync operation: ${operation}`);
        return null;
    }

    await assertCanvasIdentity();

    logger.debug(`Syncing to canvas: ${operation}`, { url, data });
    const response = await fetch(url, withCanvasAuth(options));

    // Parse JSON response regardless of HTTP status
    const result = await response.json() as ApiResponse;

    if (!response.ok) {
      logger.warn(`Canvas sync returned error status: ${response.status}`, result);
      throw new Error(result.error || `Canvas sync failed: ${response.status} ${response.statusText}`);
    }

    logger.debug(`Canvas sync successful: ${operation}`, result);
    return result as SyncResponse;

  } catch (error) {
    logger.warn(`Canvas sync failed for ${operation}:`, (error as Error).message);
    // Don't throw - we want MCP operations to work even if canvas is unavailable
    return null;
  }
}

// Helper to sync element creation to canvas.
// Sync disabled = deliberate no-op (echo the input, legacy behavior);
// sync enabled but failed = null, so callers report the failure instead of
// claiming "synced to canvas" for an element that never landed.
export async function createElementOnCanvas(elementData: ServerElement): Promise<ServerElement | null> {
  if (!ENABLE_CANVAS_SYNC) return elementData;
  const result = await syncToCanvas('create', elementData);
  return result?.element ?? null;
}

// Helper to sync element update to canvas
export async function updateElementOnCanvas(elementData: Partial<ServerElement> & { id: string }): Promise<ServerElement | null> {
  const result = await syncToCanvas('update', elementData);
  return result?.element || null;
}

// Helper to sync element deletion to canvas
export async function deleteElementOnCanvas(elementId: string): Promise<any> {
  const result = await syncToCanvas('delete', { id: elementId });
  return result;
}

// Helper to sync batch creation to canvas (same failure semantics as
// createElementOnCanvas: disabled = echo, failed = null)
export async function batchCreateElementsOnCanvas(elementsData: ServerElement[]): Promise<ServerElement[] | null> {
  if (!ENABLE_CANVAS_SYNC) return elementsData;
  const result = await syncToCanvas('batch_create', elementsData);
  return result?.elements ?? null;
}

// Helper to fetch element from canvas
export async function getElementFromCanvas(elementId: string): Promise<ServerElement | null> {
  if (!ENABLE_CANVAS_SYNC) {
    logger.debug('Canvas sync disabled, skipping fetch');
    return null;
  }

  // Before the try, for the reason `syncToCanvas` resolves it before its own: a refusal is not
  // the canvas being unreachable and must not be reported as `null`.
  const on = await boardPath('');

  try {
    await assertCanvasIdentity();
    const response = await fetch(`${EXPRESS_SERVER_URL}/api/elements/${elementId}${on}`,
      withCanvasAuth());
    if (!response.ok) {
      logger.warn(`Failed to fetch element ${elementId}: ${response.status}`);
      return null;
    }
    const data = await response.json() as { element?: ServerElement };
    return data.element || null;
  } catch (error) {
    logger.error('Error fetching element from canvas:', error);
    return null;
  }
}

// ---- Typed REST wrappers shared by the MCP server and CLI ----

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  await assertCanvasIdentity();
  const response = await fetch(`${EXPRESS_SERVER_URL}${path}`, withCanvasAuth(init));
  const data = await response.json().catch(() => null) as any;
  if (!response.ok) {
    throw new Error(data?.error || `HTTP server error: ${response.status} ${response.statusText}`);
  }
  return data as T;
}

/** A request about a board — which is all of them but the two below. */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(await boardPath(path), init);
}

/**
 * A request about the *process* rather than about a board.
 *
 * `status` and `doctor` ask what this canvas is, which is a question a board with three projects
 * open has one answer to. Resolving a workspace for them would make `status` refuse on exactly
 * the boards it is most worth running on.
 */
async function requestServerJson<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init);
}

export async function getElements(): Promise<ServerElement[]> {
  const data = await requestJson<ApiResponse>('/api/elements');
  return data.elements || [];
}

export async function searchElements(queryParams: URLSearchParams): Promise<ServerElement[]> {
  const data = await requestJson<ApiResponse>(`/api/elements/search?${queryParams}`);
  return data.elements || [];
}

export async function clearCanvas(): Promise<ApiResponse> {
  return requestJson<ApiResponse>('/api/elements/clear', { method: 'DELETE' });
}

export async function getFiles(): Promise<Record<string, any>> {
  const data = await requestJson<{ files?: Record<string, any> }>('/api/files');
  return data.files || {};
}

export async function postFiles(files: any[]): Promise<void> {
  await requestJson('/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(files)
  });
}

export async function exportImage(format: 'png' | 'svg', background = true): Promise<{ success: boolean; format: string; data: string }> {
  return requestJson('/api/export/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format, background })
  });
}

export async function setViewport(params: Record<string, unknown>): Promise<{ success: boolean; message?: string }> {
  return requestJson('/api/viewport', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
}

export async function saveSnapshot(name: string): Promise<any> {
  return requestJson('/api/snapshots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
}

export async function listSnapshots(): Promise<{ success: boolean; snapshots: any[]; count: number }> {
  return requestJson('/api/snapshots');
}

export async function getSnapshot(name: string): Promise<{ name: string; elements: ServerElement[]; createdAt: string }> {
  const data = await requestJson<{ success: boolean; snapshot: { name: string; elements: ServerElement[]; createdAt: string } }>(
    `/api/snapshots/${encodeURIComponent(name)}`
  );
  return data.snapshot;
}

export async function sendMermaid(mermaidDiagram: string, config?: Record<string, unknown>): Promise<ApiResponse> {
  return requestJson('/api/elements/from-mermaid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mermaidDiagram, config })
  });
}

// ---- Strict CRUD variants (throw on failure) ----
// syncToCanvas deliberately swallows errors so MCP tools degrade gracefully;
// the CLI wants hard failures with real error messages instead.

export async function createElementStrict(element: ServerElement): Promise<ServerElement> {
  const data = await requestJson<ApiResponse>('/api/elements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(element)
  });
  return data.element!;
}

export async function updateElementStrict(element: Partial<ServerElement> & { id: string }): Promise<ServerElement> {
  const data = await requestJson<ApiResponse>(`/api/elements/${element.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(element)
  });
  return data.element!;
}

export async function deleteElementStrict(id: string): Promise<ApiResponse> {
  return requestJson<ApiResponse>(`/api/elements/${id}`, { method: 'DELETE' });
}

export async function getElementStrict(id: string): Promise<ServerElement> {
  const data = await requestJson<ApiResponse>(`/api/elements/${id}`);
  if (!data.element) {
    throw new Error(`Element ${id} not found`);
  }
  return data.element;
}

export async function batchCreateElementsStrict(elements: ServerElement[]): Promise<ServerElement[]> {
  const data = await requestJson<ApiResponse>('/api/elements/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ elements })
  });
  return data.elements || [];
}

// Identity marker the canvas server puts in /health (v1.1+), and the set a
// client accepts — which is larger than one string, so that the rename can
// ship acceptance before it ships the new answer. See core/identity.ts.
export { CANVAS_SERVICE_NAME };

export function foreignServiceError(): Error {
  const error = new Error(
    `Something is answering at ${EXPRESS_SERVER_URL} but does not identify as this canvas server ` +
    `(a pre-1.1 canvas build or an unrelated service on the port). ` +
    `Upgrade/stop that service, or point EXPRESS_SERVER_URL elsewhere.`
  );
  (error as any).code = 'CANVAS_UNREACHABLE';
  return error;
}

// Revalidating identity gate in front of every /api request: mutations must
// not reach a foreign service squatting on the canvas port. The verification
// is cached only briefly (burst-coalescing TTL) so a long-lived MCP server
// re-checks identity after its verified canvas goes away — a service swapped
// onto the port is refused within seconds, while batch operations (align =
// many concurrent requests) share a single probe instead of stampeding
// /health. Note this is defense-in-depth against accidents, not a security
// boundary: local processes can always reach a loopback port directly.
const IDENTITY_TTL_MS = 3000;
let identityVerifiedAt = 0;
let identityProbe: Promise<void> | null = null;

export function markCanvasIdentityVerified(): void {
  identityVerifiedAt = Date.now();
}

async function assertCanvasIdentity(): Promise<void> {
  if (Date.now() - identityVerifiedAt < IDENTITY_TTL_MS) return;

  if (!identityProbe) {
    identityProbe = (async () => {
      try {
        let response: Response;
        try {
          response = await fetch(`${EXPRESS_SERVER_URL}/health`, { signal: AbortSignal.timeout(1500) });
        } catch (error) {
          // Fail CLOSED on timeout: a listener that accepts connections but
          // never answers /health could still be a foreign service that
          // would accept /api mutations.
          const name = (error as { name?: string })?.name;
          if (name === 'TimeoutError' || name === 'AbortError') {
            const timeoutError = new Error(
              `The service at ${EXPRESS_SERVER_URL} did not answer the /health identity probe within 1500ms — ` +
              `refusing to send it requests.`
            );
            (timeoutError as any).code = 'CANVAS_UNREACHABLE';
            throw timeoutError;
          }
          // Connection-level unreachable (refused/reset/DNS): canvas is down
          // or booting — let the actual request fail with its own error.
          // Deliberately not marked verified, so the next call re-probes.
          return;
        }

        // SOMETHING answered. Only a 200 with our identity payload may pass —
        // a 404 or an HTML page here is a foreign service, not a down canvas.
        let health: { service?: string } | null = null;
        try {
          health = await response.json() as { service?: string };
        } catch { /* non-JSON body: foreign */ }

        if (!response.ok || !isAcceptedCanvasService(health?.service)) {
          throw foreignServiceError();
        }
        identityVerifiedAt = Date.now();
      } finally {
        identityProbe = null;
      }
    })();
  }

  return identityProbe;
}

export interface HealthStatus {
  status: string;
  timestamp: string;
  elements_count: number;
  websocket_clients: number;
  // Identity fields (v1.1+); `stop` requires both before signaling anything
  service?: string;
  pid?: number;
  /**
   * The package version the answering build was made from.
   *
   * Optional because a canvas started from an older build answers everything above and none of
   * this — and that absence is itself the answer `core/spawn.ts` acts on: a responder that
   * cannot name its build is by construction older than the one asking.
   */
  version?: string;
  /** Runs in flight on that server, across every workspace. Absent on a build before #347. */
  implementing?: number;
  /**
   * What the agent preflight found, per role and per environment. Optional because a canvas
   * from an older build answers everything above and none of this — `doctor` says so rather
   * than reading `undefined` as "no agents".
   */
  agents?: AgentsHealth;
}

export async function getHealth(timeoutMs = 2000): Promise<HealthStatus> {
  const response = await fetch(`${EXPRESS_SERVER_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }
  return await response.json() as HealthStatus;
}

export async function getSyncStatus(): Promise<Record<string, unknown>> {
  return requestServerJson('/api/sync/status');
}
