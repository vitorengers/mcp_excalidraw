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
import { ServerElement } from '../types.js';

/** Store used when a request names no workspace. Keeps single-board setups working. */
export const DEFAULT_WORKSPACE_ID = 'default';

/** Told which workspace changed, every time one does. */
type StoreListener = (workspaceId: string) => void;

let storeListener: StoreListener | null = null;

/**
 * Watch every store for changes, from one place.
 *
 * The alternative was a call at each write, and there are around a dozen of them —
 * the element routes, the batch, the sync reconciliation, the issue and implement
 * writers, the seed. A listener that is missed at one of those is a change that is
 * silently never saved, which is the failure this exists to end (#225), so the
 * notification is the store's own rather than each caller's to remember.
 */
export function onElementStoreChanged(listener: StoreListener | null): void {
  storeListener = listener;
}

/**
 * A store that says when it changed.
 *
 * Only the three mutating methods are overridden, because they are the whole of the
 * surface: a `ServerElement` is replaced rather than edited in place everywhere in this
 * codebase — `store.set(id, { ...existing, … })` — which is what makes watching the Map
 * enough.
 */
class WatchedElementStore extends Map<string, ServerElement> {
  constructor(private readonly workspaceId: string) {
    super();
  }

  private changed(): void {
    storeListener?.(this.workspaceId);
  }

  override set(id: string, element: ServerElement): this {
    super.set(id, element);
    this.changed();
    return this;
  }

  override delete(id: string): boolean {
    const removed = super.delete(id);
    if (removed) this.changed();
    return removed;
  }

  override clear(): void {
    super.clear();
    this.changed();
  }
}

/**
 * Every store, `default` included.
 *
 * `default` used to be seeded here with the plain `Map` that `types.ts` exported, so that
 * anything importing that Map directly kept operating on the same data. It was therefore the
 * one store that could not report its own changes — and the one board a user with no project
 * registered draws on, which made it the one board that structurally could not be saved
 * (#314). Nothing imported the Map any more by then, so the export went and the special case
 * with it: `default` is created on first use like every other store, and is watched like
 * every other store.
 */
const stores = new Map<string, Map<string, ServerElement>>();

/** Element store for a workspace, created empty on first use. */
export function elementsFor(workspaceId: string | undefined | null): Map<string, ServerElement> {
  const id = normalizeWorkspaceId(workspaceId);
  let store = stores.get(id);
  if (!store) {
    store = new WatchedElementStore(id);
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

/** Test seam: drop every store, `default` included — it is no longer anyone else's object. */
export function resetStores(): void {
  stores.clear();
}
