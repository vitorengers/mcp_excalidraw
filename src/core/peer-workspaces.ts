/**
 * One peer's projects, as tabs on this board's strip — DRAFT, and deliberately the wrong one.
 *
 * This is the shape a first pass takes when nobody has written the decision down: a peer that
 * does not answer contributes a *project* carrying the reason in `error`, because there is one
 * obvious field that already draws a warning marker on a tab and it is right there. Committed on
 * purpose so that `scripts/check-peer-workspaces.mjs` is proved red against it before the module
 * it is really about goes in — the check that is written after the fix describes the fix.
 */

import { TOKEN_HEADER } from './board-token.js';
import {
  PEER_CONNECT_BUDGET_MS,
  PEER_REQUEST_BUDGET_MS,
  createPeerLiveness,
  type PeerLiveness,
  type PeerLivenessDesk,
  type PeerTarget
} from './peer-liveness.js';
import { mintRemoteWorkspaceId } from './remote-workspace-id.js';
import {
  projectWorkspaceForPeer,
  remoteWorkspaceLocation,
  type RemoteWorkspaceView
} from './remote-workspace-view.js';

/** As much of a peer record as this module reads. A `PeerRecord` satisfies it. */
export interface PeerBoard {
  id: string;
  name: string;
  baseUrl: string;
  secret?: string;
}

export interface PeerWorkspaceTab {
  id: string;
  peerId: string;
  remoteId: string;
  name: string;
  error: string | null;
  location: string;
}

export interface PeerWorkspaces {
  peerId: string;
  peerName: string;
  baseUrl: string;
  /** Null when the peer did not answer — the draft has nowhere else to put that. */
  liveness: PeerLiveness | null;
  workspaces: PeerWorkspaceTab[];
  refusals: string[];
}

export type PeerWorkspacesReply =
  | { ok: true; workspaces: unknown }
  | { ok: false; refused: boolean; reason: string };

export type PeerWorkspacesTransport = (target: PeerTarget) => Promise<PeerWorkspacesReply>;

export interface PeerWorkspacesDeps {
  liveness?: PeerLivenessDesk;
  transport?: PeerWorkspacesTransport;
  now?: () => number;
}

export const PEER_WORKSPACES_BUDGET_MS = PEER_CONNECT_BUDGET_MS + 3 * PEER_REQUEST_BUDGET_MS;

const PEER_WORKSPACES_PATH = '/api/workspaces';

const QUOTE_BUDGET = 300;

function said(body: string): string {
  let text = body.trim();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) text = parsed.error.trim();
  } catch { /* not JSON; whatever it sent is still what it said */ }
  if (!text) return 'nothing at all';
  return text.length > QUOTE_BUDGET ? `${text.slice(0, QUOTE_BUDGET)}…` : text;
}

async function askOverHttp(target: PeerTarget): Promise<PeerWorkspacesReply> {
  const where = `${target.url}${PEER_WORKSPACES_PATH}`;
  try {
    const response = await fetch(where, {
      headers: target.token ? { [TOKEN_HEADER]: target.token } : {},
      signal: AbortSignal.timeout(PEER_REQUEST_BUDGET_MS)
    });
    const body = await response.text();
    if (response.status < 200 || response.status > 299) {
      return {
        ok: false,
        refused: response.status === 401 || response.status === 403,
        reason: `${where} answered ${response.status}. It said: ${said(body)}`
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, refused: false, reason: `${where} did not answer with JSON.` };
    }
    return { ok: true, workspaces: (parsed as { workspaces?: unknown } | null)?.workspaces };
  } catch (error) {
    return { ok: false, refused: false, reason: `${where} could not be read: ${(error as Error).message}` };
  }
}

function readRecord(value: unknown): RemoteWorkspaceView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) return null;
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
  const error = typeof entry.error === 'string' && entry.error.trim() ? entry.error.trim() : null;
  return projectWorkspaceForPeer({ id, name, error });
}

/** The draft's answer to a peer that is not there: one project, and the reason in its `error`. */
function asleep(peer: PeerBoard, reason: string): PeerWorkspaces {
  const view: RemoteWorkspaceView = { id: peer.id, name: peer.name, error: reason };
  return {
    peerId: peer.id,
    peerName: peer.name,
    baseUrl: peer.baseUrl,
    liveness: null,
    workspaces: [{
      id: `${peer.id}`,
      peerId: peer.id,
      remoteId: peer.id,
      name: peer.name,
      error: reason,
      location: remoteWorkspaceLocation(view, peer.name)
    }],
    refusals: []
  };
}

function withBudget(work: () => Promise<PeerWorkspaces>, late: () => PeerWorkspaces): Promise<PeerWorkspaces> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overdue = new Promise<PeerWorkspaces>(resolve => {
    timer = setTimeout(() => resolve(late()), PEER_WORKSPACES_BUDGET_MS);
  });
  return Promise.race([work(), overdue]).finally(() => { if (timer) clearTimeout(timer); });
}

export function listPeerWorkspaces(
  peer: PeerBoard,
  deps: PeerWorkspacesDeps = {}
): Promise<PeerWorkspaces> {
  const liveness = deps.liveness ?? createPeerLiveness();
  const transport = deps.transport ?? askOverHttp;
  const target: PeerTarget = {
    url: peer.baseUrl,
    ...(peer.secret ? { token: peer.secret } : {})
  };

  return withBudget(async () => {
    const state = await liveness.check(target);
    if (state.state !== 'online') return asleep(peer, state.reason);

    const reply = await transport(target);
    if (!reply.ok) return asleep(peer, reply.reason);

    const records = Array.isArray(reply.workspaces) ? reply.workspaces : [];
    const workspaces: PeerWorkspaceTab[] = [];
    const refusals: string[] = [];
    for (const record of records) {
      const view = readRecord(record);
      if (!view) {
        refusals.push('A record the peer sent is not a project this board can name: it has no id.');
        continue;
      }
      const minted = mintRemoteWorkspaceId(peer.id, view.id);
      if (!minted.ok) {
        refusals.push(minted.refusal);
        continue;
      }
      workspaces.push({
        id: minted.id,
        peerId: peer.id,
        remoteId: view.id,
        name: view.name,
        error: view.error,
        location: remoteWorkspaceLocation(view, peer.name)
      });
    }

    return {
      peerId: peer.id,
      peerName: peer.name,
      baseUrl: peer.baseUrl,
      liveness: state,
      workspaces,
      refusals
    };
  }, () => asleep(peer, `${peer.baseUrl} did not answer within ${PEER_WORKSPACES_BUDGET_MS} ms.`));
}
