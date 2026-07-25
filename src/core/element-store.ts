/**
 * Element storage, one store per workspace.
 *
 * Elements used to live in a single module-level Map, which is fine while a server
 * serves one board. With several projects open as tabs, that Map would let one board's
 * autosync reach into another's elements — the same class of silent data loss as the
 * clear-and-replace sync this project already fixed.
 *
 * Stores are created on first use. There is no registration step: an unknown workspace
 * id yields an empty store rather than an error, so a board can exist before its
 * project is listed in the registry, and a typo costs an empty canvas instead of
 * corrupting a real one.
 */
import { elements as defaultElements, ServerElement } from '../types.js';

/** Store used when a request names no workspace. Keeps single-board setups working. */
export const DEFAULT_WORKSPACE_ID = 'default';

const stores = new Map<string, Map<string, ServerElement>>([
  // The default store is the Map exported from types.ts, so anything still importing
  // it directly — the CLI, for one — keeps operating on the same data.
  [DEFAULT_WORKSPACE_ID, defaultElements],
]);

/** Element store for a workspace, created empty on first use. */
export function elementsFor(workspaceId: string | undefined | null): Map<string, ServerElement> {
  const id = normalizeWorkspaceId(workspaceId);
  let store = stores.get(id);
  if (!store) {
    store = new Map<string, ServerElement>();
    stores.set(id, store);
  }
  return store;
}

/**
 * Workspace id a request is talking about.
 *
 * Accepts `?workspace=` or an `x-workspace-id` header. Anything missing or malformed
 * resolves to the default store instead of failing: a request that cannot name its
 * workspace is far more likely to be an older client than an attack.
 */
export function workspaceIdFrom(source: {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): string {
  const candidates = [
    source.query?.workspace,
    source.body?.workspace,
    source.headers?.['x-workspace-id'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return normalizeWorkspaceId(candidate);
  }
  return DEFAULT_WORKSPACE_ID;
}

/** Ids reach us from URLs and headers; keep them to a shape safe to log and compare. */
export function normalizeWorkspaceId(id: string | undefined | null): string {
  if (typeof id !== 'string') return DEFAULT_WORKSPACE_ID;
  const trimmed = id.trim().toLowerCase();
  if (!trimmed || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmed)) return DEFAULT_WORKSPACE_ID;
  return trimmed;
}

/** Workspace ids that currently hold elements. */
export function activeWorkspaceIds(): string[] {
  return [...stores.keys()];
}

/** Test seam: drop every store but the default, which is emptied in place. */
export function resetStores(): void {
  for (const [id, store] of stores) {
    if (id === DEFAULT_WORKSPACE_ID) store.clear();
    else stores.delete(id);
  }
}
